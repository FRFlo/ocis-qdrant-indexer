import { convert } from "@opendataloader/pdf";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.ts";

export interface ParsedDocument {
	text: string;
	title?: string;
}

export async function extractText(filename: string, buffer: Buffer): Promise<ParsedDocument> {
	const ext = filename.split(".").pop()?.toLowerCase() || "";
	const title = filename.split(/[\\/]/).pop() || filename;

	if (ext === "pdf") {
		const workDir = await mkdtemp(join(tmpdir(), "ocis-qdrant-pdf-"));
		const inputPath = join(workDir, title || "document.pdf");
		try {
			await writeFile(inputPath, buffer);
			const text = await convert(inputPath, {
				format: "markdown",
				toStdout: true,
				quiet: true,
			});
			return { text: text.trim(), title: filename };
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	}

	try {
		if (buffer.includes(0)) throw new Error("Contenu binaire");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim();
		return { text, title };
	} catch {
		// Non-UTF-8 content is delegated to Tika when it is configured.
	}

	if (!config.tikaUrl) return { text: "", title };

	const endpoint = config.tikaUrl.endsWith("/tika") ? config.tikaUrl : `${config.tikaUrl}/tika`;
	const response = await fetch(endpoint, {
		method: "PUT",
		headers: {
			Accept: "text/plain",
			"Content-Type": "application/octet-stream",
		},
		body: buffer,
		signal: AbortSignal.timeout(config.ocisRequestTimeoutMs),
	});
	if (!response.ok) {
		const details = (await response.text()).slice(0, 500);
		const message = `Échec de l'extraction Tika (${response.status} ${response.statusText}) pour ${filename}${details ? ` : ${details}` : ""}`;
		if ([400, 415, 422, 500].includes(response.status)) {
			console.warn(`[Parser] Fichier non pris en charge par Tika : ${message}`);
			return { text: "", title };
		}
		throw new Error(message);
	}
	return { text: (await response.text()).trim(), title };
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
