import asyncio
import io
import threading
from contextlib import asynccontextmanager

import fitz
from fastapi import FastAPI, HTTPException, UploadFile
import numpy as np
from PIL import Image, UnidentifiedImageError
from paddleocr import PaddleOCR

MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_PDF_PAGES = 100
PDF_RENDER_DPI = 150
ocr_engine: PaddleOCR | None = None
ocr_lock = threading.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    global ocr_engine
    ocr_engine = PaddleOCR(use_angle_cls=True, lang="fr", use_gpu=False, show_log=False)
    yield
    ocr_engine = None


app = FastAPI(title="oCIS PaddleOCR", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok", "ready": ocr_engine is not None}


def recognize(image: Image.Image) -> str:
    if ocr_engine is None:
        raise RuntimeError("PaddleOCR is not initialized")
    image = image.convert("RGB")
    pixels = np.asarray(image)[:, :, ::-1].copy()
    with ocr_lock:
        result = ocr_engine.ocr(pixels, cls=True)
    lines = result[0] if result else []
    return "\n".join(line[1][0].strip() for line in lines if line and line[1][0].strip())


@app.post("/ocr")
async def ocr(file: UploadFile):
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File exceeds 50 MiB")
    filename = (file.filename or "").lower()

    try:
        if filename.endswith(".pdf"):
            pages = []
            with fitz.open(stream=contents, filetype="pdf") as document:
                if document.page_count > MAX_PDF_PAGES:
                    raise HTTPException(status_code=413, detail="PDF exceeds 100 pages")
                scale = PDF_RENDER_DPI / 72
                for index, page in enumerate(document):
                    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                    image = Image.open(io.BytesIO(pixmap.tobytes("png")))
                    pages.append({"page": index + 1, "text": await asyncio.to_thread(recognize, image)})
        else:
            image = Image.open(io.BytesIO(contents))
            pages = [{"page": 1, "text": await asyncio.to_thread(recognize, image)}]
    except HTTPException:
        raise
    except (fitz.FileDataError, fitz.EmptyFileError, UnidentifiedImageError) as error:
        raise HTTPException(status_code=422, detail=f"OCR failed: {error}") from error
    except Exception as error:
        raise HTTPException(status_code=500, detail="PaddleOCR inference failed") from error

    return {"pages": pages}
