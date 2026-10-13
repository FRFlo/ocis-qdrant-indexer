import { afterEach, describe, expect, it, mock } from "bun:test";
import { config } from "./config.ts";
import { chunkText, extractText } from "./parser.ts";

const countTestTokens = (text: string) => Array.from(text).length;
const originalFetch = globalThis.fetch;
const originalTikaUrl = config.tikaUrl;
const originalPaddleOcrUrl = config.paddleOcrUrl;

afterEach(() => {
	globalThis.fetch = originalFetch;
	config.tikaUrl = originalTikaUrl;
	config.paddleOcrUrl = originalPaddleOcrUrl;
});

describe("parser", () => {
	it("extrait un PDF en Markdown avec OpenDataLoader", async () => {
		const content = "BT /F1 18 Tf 72 720 Td (Hello OpenDataLoader PDF) Tj ET";
		const objects = [
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
			"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
			`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		];
		let pdf = "%PDF-1.4\n";
		const offsets = [0];
		for (const [index, object] of objects.entries()) {
			offsets.push(Buffer.byteLength(pdf, "ascii"));
			pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		}
		const xrefOffset = Buffer.byteLength(pdf, "ascii");
		pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
		for (const offset of offsets.slice(1)) {
			pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
		}
		pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

		const parsed = await extractText("sample.pdf", Buffer.from(pdf, "ascii"));

		expect(parsed.text).toContain("Hello OpenDataLoader PDF");
	});

	it("utilise PaddleOCR si l'extraction native du PDF est vide", async () => {
		const content = "BT /F1 18 Tf 72 720 Td ( ) Tj ET";
		const objects = [
			"<< /Type /Catalog /Pages 2 0 R >>",
			"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
			"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
			`<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		];
		let pdf = "%PDF-1.4\n";
		const offsets = [0];
		for (const [index, object] of objects.entries()) {
			offsets.push(Buffer.byteLength(pdf, "ascii"));
			pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
		}
		const xrefOffset = Buffer.byteLength(pdf, "ascii");
		pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
		for (const offset of offsets.slice(1)) {
			pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
		}
		pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
		const fetchMock = mock(async () =>
			Response.json({ pages: [{ page: 1, text: "Texte reconnu par PaddleOCR" }] }),
		);
		config.paddleOcrUrl = "http://paddleocr:8080";
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const parsed = await extractText("scan.pdf", Buffer.from(pdf, "ascii"));

		expect(parsed.text).toContain("## Page 1");
		expect(parsed.text).toContain("Texte reconnu par PaddleOCR");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("essaie PaddleOCR sur une image binaire et conserve sa page", async () => {
		config.paddleOcrUrl = "http://paddleocr:8080";
		globalThis.fetch = mock(async () =>
			Response.json({ pages: [{ page: 1, text: "Texte de l'image" }] }),
		) as unknown as typeof fetch;

		await expect(
			extractText("scan.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])),
		).resolves.toMatchObject({ text: "## Page 1\n\nTexte de l'image" });
	});

	it("sérialise uniquement les appels PaddleOCR", async () => {
		config.paddleOcrUrl = "http://paddleocr:8080";
		let activeRequests = 0;
		let maxActiveRequests = 0;
		globalThis.fetch = mock(async () => {
			activeRequests++;
			maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
			await new Promise((resolve) => setTimeout(resolve, 20));
			activeRequests--;
			return Response.json({ pages: [{ page: 1, text: "Texte reconnu" }] });
		}) as unknown as typeof fetch;

		await Promise.all([
			extractText("scan-1.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
			extractText("scan-2.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
		]);

		expect(maxActiveRequests).toBe(1);
	});

	it("réessaie l'indexation lorsque PaddleOCR est indisponible", async () => {
		config.paddleOcrUrl = "http://paddleocr:8080";
		globalThis.fetch = mock(
			async () => new Response("Service unavailable", { status: 503 }),
		) as unknown as typeof fetch;

		await expect(extractText("scan.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]))).rejects.toThrow(
			"PaddleOCR (503",
		);

		globalThis.fetch = mock(async () =>
			Response.json({ pages: [{ page: 1, text: "OCR toujours disponible" }] }),
		) as unknown as typeof fetch;
		await expect(
			extractText("scan-suivant.png", Buffer.from([0x89, 0x50, 0x4e, 0x47])),
		).resolves.toMatchObject({ text: "## Page 1\n\nOCR toujours disponible" });
	});

	it("découpe un texte correctement selon les paragraphes et la taille", () => {
		const text = `Premier paragraphe d'introduction au cours.

Deuxième paragraphe contenant des explications plus longues avec des détails importants sur l'architecture logicielle.

Troisième paragraphe de conclusion.`;

		const chunks = chunkText(text, countTestTokens, 100);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]?.text).toContain("Premier paragraphe");
		expect(chunks[0]?.chunkIndex).toBe(0);
	});

	it("splits oversized paragraphs at sentence boundaries within the input budget", () => {
		const longParagraph = "Une phrase complète. ".repeat(12).trim();
		const chunks = chunkText(`${longParagraph}\n\nParagraphe suivant.`, countTestTokens, 50);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => countTestTokens(chunk.text) <= 50)).toBe(true);
		expect(chunks.map((chunk) => chunk.text).join(" ")).toContain(
			longParagraph.replace(/\s+/g, " "),
		);
	});

	it("splits oversized Markdown tables by rows while repeating the table header", () => {
		const table = [
			"| Sujet | Description |",
			"| --- | --- |",
			"| Projet | Une description suffisamment longue pour dépasser la taille cible. |",
			"| Suite | Une seconde ligne de tableau qui reste attachée à la première. |",
		].join("\n");
		const chunks = chunkText(`${table}\n\nConclusion.`, countTestTokens, 64);
		const tableChunks = chunks.filter((chunk) => chunk.text.includes("|"));

		expect(chunks.length).toBeGreaterThan(2);
		expect(tableChunks.every((chunk) => chunk.text.includes("| Sujet | Description |"))).toBe(true);
		expect(chunks.every((chunk) => countTestTokens(chunk.text) <= 64)).toBe(true);
		expect(chunks.at(-1)?.text).toContain("Conclusion.");
	});

	it("keeps fenced code blocks together across blank lines", () => {
		const codeBlock = "```ts\nconst first = 1;\n\nconst second = 2;\n```";
		const chunks = chunkText(`${codeBlock}\n\nTexte final.`, countTestTokens, 50);

		expect(chunks[0]?.text).toBe(codeBlock);
		expect(chunks[1]?.text).toBe("Texte final.");
	});

	it("keeps heading hierarchy as context in each section chunk", () => {
		const text = [
			"# Guide",
			"## Installation",
			"Installer les dépendances.",
			"Configurer le service.",
			"Vérifier la connexion.",
			"## Dépannage",
			"Redémarrer le service.",
		].join("\n\n");
		const chunks = chunkText(text, countTestTokens, 60);
		const installationChunks = chunks.filter((chunk) => chunk.text.includes("## Installation"));
		const troubleshootingChunks = chunks.filter((chunk) => chunk.text.includes("## Dépannage"));

		expect(installationChunks.length).toBeGreaterThan(1);
		expect(
			installationChunks.every((chunk) => chunk.text.includes("# Guide\n\n## Installation")),
		).toBe(true);
		expect(troubleshootingChunks.length).toBeGreaterThan(0);
		expect(
			troubleshootingChunks.every(
				(chunk) =>
					chunk.text.includes("# Guide\n\n## Dépannage") && !chunk.text.includes("Installation"),
			),
		).toBe(true);
	});

	it("enforces the token ceiling without splitting Unicode characters", () => {
		const chunks = chunkText("é🙂".repeat(100), countTestTokens, 48);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => countTestTokens(chunk.text) <= 48)).toBe(true);
		expect(chunks.every((chunk) => !chunk.text.includes("�"))).toBe(true);
	});

	it("extrait le texte d'un fichier markdown ou texte brut", async () => {
		const buffer = Buffer.from("# Titre du cours\n\nContenu en markdown.");
		const parsed = await extractText("cours.md", buffer);

		expect(parsed.title).toBe("cours.md");
		expect(parsed.text).toContain("Titre du cours");
	});

	it("indexe tout fichier texte valide en UTF-8, quel que soit son suffixe", async () => {
		const parsed = await extractText("notes.custom", Buffer.from("Texte UTF-8 valide"));

		expect(parsed.text).toBe("Texte UTF-8 valide");
	});

	it("ignore les contenus binaires et les séquences UTF-8 invalides", async () => {
		await expect(
			extractText("archive.zip", Buffer.from([0x50, 0x4b, 0x00, 0x01])),
		).resolves.toMatchObject({
			text: "",
		});
		await expect(extractText("unknown.bin", Buffer.from([0xff, 0xfe]))).resolves.toMatchObject({
			text: "",
		});
	});

	it("envoie un contenu binaire quelconque à Tika lorsqu'il est configuré", async () => {
		config.tikaUrl = "http://tika:9998";
		const fetchMock = mock(
			async (_input: string | URL | Request, _init?: RequestInit) =>
				new Response("Document Office extrait"),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const parsed = await extractText("archive.custom", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));

		expect(parsed).toEqual({ text: "Document Office extrait", title: "archive.custom" });
		expect(fetchMock).toHaveBeenCalledWith(
			"http://tika:9998/tika/md",
			expect.objectContaining({ method: "PUT" }),
		);
	});

	it("n'indexe pas les fichiers binaires sans Tika", async () => {
		config.tikaUrl = undefined;
		await expect(
			extractText("report.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])),
		).resolves.toMatchObject({
			text: "",
		});
	});

	it("treats Tika parse errors as non-parseable files", async () => {
		config.tikaUrl = "http://tika:9998";
		globalThis.fetch = mock(
			async () =>
				new Response("Parser failed", { status: 500, statusText: "Internal Server Error" }),
		) as unknown as typeof fetch;
		const warn = mock((message: string) => message);
		const originalWarn = console.warn;
		console.warn = warn;
		try {
			await expect(extractText("unknown.bin", Buffer.from([0x00, 0xff]))).resolves.toMatchObject({
				text: "",
			});
			expect(warn).toHaveBeenCalledTimes(1);
			expect(warn.mock.calls[0]?.[0]).toContain("500 Internal Server Error");
		} finally {
			console.warn = originalWarn;
		}
	});

	it("surfaces Tika server errors so indexing can be retried", async () => {
		config.tikaUrl = "http://tika:9998";
		globalThis.fetch = mock(
			async () => new Response("Server failure", { status: 503, statusText: "Unavailable" }),
		) as unknown as typeof fetch;

		await expect(extractText("unknown.bin", Buffer.from([0x00, 0xff]))).rejects.toThrow(
			"503 Unavailable",
		);
	});
});
