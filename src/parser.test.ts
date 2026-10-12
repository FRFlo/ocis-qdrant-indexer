import { describe, expect, it } from "bun:test";
import { chunkText, extractText, isSupportedFile } from "./parser.ts";

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

	it("découpe un texte correctement selon les paragraphes et la taille", () => {
		const text = `Premier paragraphe d'introduction au cours.

Deuxième paragraphe contenant des explications plus longues avec des détails importants sur l'architecture logicielle.

Troisième paragraphe de conclusion.`;

		const chunks = chunkText(text, 100, 20);
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks[0]?.text).toContain("Premier paragraphe");
		expect(chunks[0]?.chunkIndex).toBe(0);
	});

	it("extrait le texte d'un fichier markdown ou texte brut", async () => {
		const buffer = Buffer.from("# Titre du cours\n\nContenu en markdown.");
		const parsed = await extractText("cours.md", buffer);

		expect(parsed.title).toBe("cours.md");
		expect(parsed.text).toContain("Titre du cours");
	});

	it("identifies only formats supported by the indexer", () => {
		expect(isSupportedFile("Cours.PDF")).toBe(true);
		expect(isSupportedFile("notes.md")).toBe(true);
		expect(isSupportedFile("archive.zip")).toBe(false);
	});
});
