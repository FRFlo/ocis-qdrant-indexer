import { describe, expect, it } from "bun:test";
import { chunkText, extractText } from "./parser.ts";

describe("parser", () => {
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
});
