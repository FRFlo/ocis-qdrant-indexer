import pdfParse from "pdf-parse";

export interface ParsedDocument {
	text: string;
	title?: string;
}

const supportedExtensions = new Set([
	"txt",
	"md",
	"markdown",
	"json",
	"yaml",
	"yml",
	"csv",
	"html",
	"xml",
	"js",
	"ts",
	"py",
	"java",
	"c",
	"cpp",
	"puml",
	"pdf",
]);

export function isSupportedFile(filename: string): boolean {
	const ext = filename.split(".").pop()?.toLowerCase() || "";
	return supportedExtensions.has(ext);
}

export async function extractText(filename: string, buffer: Buffer): Promise<ParsedDocument> {
	const ext = filename.split(".").pop()?.toLowerCase() || "";

	if (ext === "pdf") {
		const data = await pdfParse(buffer);
		return {
			text: data.text,
			title: data.info?.Title || filename,
		};
	}

	if (supportedExtensions.has(ext) && ext !== "pdf") {
		return {
			text: buffer.toString("utf-8"),
			title: filename,
		};
	}

	// Pour les formats binaires inconnus ou non supportés directement
	return {
		text: "",
		title: filename,
	};
}

export interface Chunk {
	text: string;
	chunkIndex: number;
}

export function chunkText(text: string, maxChunkSize = 1000, overlap = 150): Chunk[] {
	const clean = text.replace(/\r\n/g, "\n").trim();
	if (!clean) return [];

	const paragraphs = clean.split(/\n\s*\n/);
	const chunks: Chunk[] = [];
	let currentChunk = "";
	let chunkIndex = 0;

	for (const p of paragraphs) {
		const paragraph = p.trim();
		if (!paragraph) continue;

		if (currentChunk.length + paragraph.length <= maxChunkSize) {
			currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
		} else {
			if (currentChunk) {
				chunks.push({ text: currentChunk, chunkIndex: chunkIndex++ });
			}

			// Si le paragraphe seul est plus grand que maxChunkSize, on le découpe par taille fixe
			if (paragraph.length > maxChunkSize) {
				let start = 0;
				while (start < paragraph.length) {
					const end = Math.min(start + maxChunkSize, paragraph.length);
					chunks.push({
						text: paragraph.substring(start, end),
						chunkIndex: chunkIndex++,
					});
					start += maxChunkSize - overlap;
				}
				currentChunk = "";
			} else {
				// Repart avec un léger overlap
				currentChunk = paragraph;
			}
		}
	}

	if (currentChunk.trim()) {
		chunks.push({ text: currentChunk.trim(), chunkIndex: chunkIndex++ });
	}

	return chunks;
}
