import { convert } from "@opendataloader/pdf";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { config } from "./config.ts";
import type { TokenCounter } from "./tokenizer.ts";

export interface ParsedDocument {
	text: string;
	title?: string;
}

const ocrExtensions = new Set(["pdf", "png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"]);
let paddleOcrQueue = Promise.resolve();

async function withPaddleOcrSlot<T>(operation: () => Promise<T>): Promise<T> {
	let release!: () => void;
	const previous = paddleOcrQueue;
	paddleOcrQueue = new Promise<void>((resolve) => {
		release = resolve;
	});
	await previous;
	try {
		return await operation();
	} finally {
		release();
	}
}

async function extractWithPaddleOcr(
	filename: string,
	buffer: Buffer,
	title: string,
): Promise<ParsedDocument> {
	if (!config.paddleOcrUrl || !ocrExtensions.has(filename.split(".").pop()?.toLowerCase() || "")) {
		return { text: "", title };
	}

	return withPaddleOcrSlot(async () => {
		const form = new FormData();
		form.append(
			"file",
			new Blob([new Uint8Array(buffer)], { type: "application/octet-stream" }),
			title,
		);
		const response = await fetch(`${config.paddleOcrUrl}/ocr`, {
			method: "POST",
			body: form,
			signal: AbortSignal.timeout(config.paddleOcrTimeoutMs),
		});
		if (!response.ok) {
			const details = (await response.text()).slice(0, 500);
			if ([400, 413, 415, 422].includes(response.status)) {
				console.warn(
					`[Parser] Document non exploitable par PaddleOCR (${response.status}) pour ${filename}${details ? ` : ${details}` : ""}`,
				);
				return { text: "", title };
			}
			throw new Error(
				`Échec PaddleOCR (${response.status} ${response.statusText}) pour ${filename}${details ? ` : ${details}` : ""}`,
			);
		}
		const result = (await response.json()) as {
			pages?: Array<{ page: number; text: string }>;
		};
		const text = (result.pages ?? [])
			.map((page) => (page.text.trim() ? `## Page ${page.page}\n\n${page.text.trim()}` : ""))
			.filter(Boolean)
			.join("\n\n");
		return { text, title };
	});
}

export async function extractText(filename: string, buffer: Buffer): Promise<ParsedDocument> {
	const ext = filename.split(".").pop()?.toLowerCase() || "";
	const title = filename.split(/[\\/]/).pop() || filename;

	if (ext === "pdf") {
		const workDir = await mkdtemp(join(tmpdir(), "ocis-qdrant-pdf-"));
		const inputPath = join(workDir, title || "document.pdf");
		try {
			await writeFile(inputPath, buffer);
			let text: string;
			try {
				text = await convert(inputPath, {
					format: "markdown",
					toStdout: true,
					quiet: true,
				});
			} catch (error) {
				if (config.paddleOcrUrl) {
					console.warn(`[Parser] Extraction PDF native échouée, essai OCR pour ${filename}.`);
					return await extractWithPaddleOcr(filename, buffer, filename);
				}
				throw error;
			}
			const extracted = text.trim();
			return extracted
				? { text: extracted, title: filename }
				: extractWithPaddleOcr(filename, buffer, filename);
		} finally {
			await rm(workDir, { recursive: true, force: true });
		}
	}

	if (["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"].includes(ext) && config.paddleOcrUrl) {
		return extractWithPaddleOcr(filename, buffer, title);
	}

	try {
		if (buffer.includes(0)) throw new Error("Contenu binaire");
		const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim();
		return { text, title };
	} catch {
		// Non-UTF-8 content is delegated to Tika when it is configured.
	}

	if (!config.tikaUrl) return extractWithPaddleOcr(filename, buffer, title);

	const endpoint = config.tikaUrl.endsWith("/tika/md")
		? config.tikaUrl
		: config.tikaUrl.endsWith("/tika")
			? `${config.tikaUrl}/md`
			: `${config.tikaUrl}/tika/md`;
	const response = await fetch(endpoint, {
		method: "PUT",
		headers: {
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
			return extractWithPaddleOcr(filename, buffer, title);
		}
		throw new Error(message);
	}
	const extracted = (await response.text()).trim();
	return extracted ? { text: extracted, title } : extractWithPaddleOcr(filename, buffer, title);
}

export interface Chunk {
	text: string;
	chunkIndex: number;
}

interface MarkdownBlock {
	type: "block";
	kind: string;
	text: string;
}

interface MarkdownSection {
	type: "section";
	level: number;
	heading: string;
	children: MarkdownNode[];
}

type MarkdownNode = MarkdownBlock | MarkdownSection;

interface MarkdownEntry {
	headings: string[];
	kind: string;
	text: string;
}

interface MarkdownAstNode {
	type: string;
	depth?: number;
	value?: string;
	alt?: string;
	children?: MarkdownAstNode[];
	position?: {
		start?: { offset?: number };
		end?: { offset?: number };
	};
}

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);

function parseMarkdownTree(text: string): MarkdownNode[] {
	const root = markdownProcessor.parse(text) as unknown as MarkdownAstNode;
	const roots: MarkdownNode[] = [];
	const sectionStack: MarkdownSection[] = [];
	const sourceFor = (node: MarkdownAstNode) => {
		const start = node.position?.start?.offset;
		const end = node.position?.end?.offset;
		return typeof start === "number" && typeof end === "number" ? text.slice(start, end) : "";
	};
	const inlineText = (node: MarkdownAstNode): string =>
		node.value ?? node.alt ?? node.children?.map(inlineText).join("") ?? "";

	for (const node of root.children ?? []) {
		if (node.type === "heading" && node.depth) {
			while (sectionStack.length && sectionStack.at(-1)!.level >= node.depth) sectionStack.pop();
			const section: MarkdownSection = {
				type: "section",
				level: node.depth,
				heading: `${"#".repeat(node.depth)} ${inlineText(node).trim()}`,
				children: [],
			};
			const parent = sectionStack.at(-1);
			(parent ? parent.children : roots).push(section);
			sectionStack.push(section);
			continue;
		}

		const block: MarkdownBlock = {
			type: "block",
			kind: node.type,
			text: sourceFor(node).trim(),
		};
		if (!block.text) continue;
		const parent = sectionStack.at(-1);
		(parent ? parent.children : roots).push(block);
	}

	return roots;
}

function splitOversizedWord(word: string, maxTokens: number, countTokens: TokenCounter): string[] {
	const characters = Array.from(word);
	const chunks: string[] = [];
	let start = 0;
	while (start < characters.length) {
		let low = start + 1;
		let high = characters.length;
		let best = start;
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const candidate = characters.slice(start, middle).join("");
			if (countTokens(candidate) <= maxTokens) {
				best = middle;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		if (best === start) best = start + 1;
		chunks.push(characters.slice(start, best).join(""));
		start = best;
	}
	return chunks;
}

function splitWords(text: string, maxTokens: number, countTokens: TokenCounter): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const word of text.split(/(\s+)/u).filter(Boolean)) {
		if (countTokens(word) > maxTokens) {
			if (current.trim()) chunks.push(current.trim());
			current = "";
			const parts = splitOversizedWord(word, maxTokens, countTokens);
			chunks.push(...parts.slice(0, -1));
			current = parts.at(-1) ?? "";
			continue;
		}
		if (current && countTokens(current + word) > maxTokens) {
			chunks.push(current.trim());
			current = word.trimStart();
		} else {
			current += word;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks;
}

function splitSentences(text: string, maxTokens: number, countTokens: TokenCounter): string[] {
	const sentences = text
		.split(/(?<=[.!?。！？])\s+/u)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const chunks: string[] = [];
	let current = "";
	for (const sentence of sentences) {
		const parts =
			countTokens(sentence) > maxTokens ? splitWords(sentence, maxTokens, countTokens) : [sentence];
		for (const part of parts) {
			if (current && countTokens(`${current} ${part}`) > maxTokens) {
				chunks.push(current);
				current = part;
			} else {
				current = current ? `${current} ${part}` : part;
			}
		}
	}
	if (current) chunks.push(current);
	return chunks;
}

function splitCode(text: string, maxTokens: number, countTokens: TokenCounter): string[] {
	const lines = text.split("\n");
	const opening = lines[0] ?? "```";
	const hasFence = /^\s{0,3}(`{3,}|~{3,})/.test(opening);
	const closing =
		hasFence && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(lines.at(-1) ?? "")
			? (lines.pop() ?? "")
			: hasFence
				? opening.startsWith("~")
					? "~~~"
					: "```"
				: "";
	if (hasFence) lines.shift();
	const wrapper = hasFence ? `${opening}\n\n${closing}` : "";
	const bodyBudget = maxTokens - countTokens(wrapper);
	if (bodyBudget < 1) return splitSentences(text, maxTokens, countTokens);

	const chunks: string[] = [];
	let current = "";
	for (const line of lines) {
		const parts =
			countTokens(line) > bodyBudget ? splitSentences(line, bodyBudget, countTokens) : [line];
		for (const part of parts) {
			if (current && countTokens(`${current}\n${part}`) > bodyBudget) {
				chunks.push(hasFence ? `${opening}\n${current}\n${closing}` : current);
				current = part;
			} else {
				current = current ? `${current}\n${part}` : part;
			}
		}
	}
	if (current) chunks.push(hasFence ? `${opening}\n${current}\n${closing}` : current);
	return chunks;
}

function splitTable(text: string, maxTokens: number, countTokens: TokenCounter): string[] {
	const lines = text.split("\n");
	if (lines.length < 3) return splitSentences(text, maxTokens, countTokens);
	const header = lines.slice(0, 2).join("\n");
	const rowBudget = maxTokens - countTokens(`${header}\n\n`);
	if (rowBudget < 1) return splitSentences(text, maxTokens, countTokens);

	const chunks: string[] = [];
	let rows: string[] = [];
	const flush = () => {
		if (rows.length) chunks.push(`${header}\n${rows.join("\n")}`);
		rows = [];
	};
	for (const row of lines.slice(2)) {
		if (countTokens(row) > rowBudget) {
			flush();
			for (const part of splitSentences(row, rowBudget, countTokens))
				chunks.push(`${header}\n${part}`);
			continue;
		}
		if (rows.length && countTokens([...rows, row].join("\n")) > rowBudget) flush();
		rows.push(row);
	}
	flush();
	return chunks.length ? chunks : splitSentences(text, maxTokens, countTokens);
}

function splitBlock(
	text: string,
	kind: string,
	maxTokens: number,
	countTokens: TokenCounter,
): string[] {
	if (countTokens(text) <= maxTokens) return [text];
	if (kind === "code") return splitCode(text, maxTokens, countTokens);
	if (kind === "table") return splitTable(text, maxTokens, countTokens);
	if (kind === "list") {
		return text
			.split("\n")
			.flatMap((line) => splitSentences(line, maxTokens, countTokens))
			.filter(Boolean);
	}
	return text
		.split(/\n+/)
		.flatMap((line) => splitSentences(line, maxTokens, countTokens))
		.filter(Boolean);
}

function truncateTokens(text: string, maxTokens: number, countTokens: TokenCounter): string {
	let result = "";
	for (const character of Array.from(text)) {
		const candidate = result + character;
		if (countTokens(candidate) <= maxTokens) result = candidate;
	}
	return result;
}

function fitHeadingPath(
	headings: string[],
	maxTokens: number,
	countTokens: TokenCounter,
): string[] {
	if (!headings.length) return headings;
	const fullPath = headings.join("\n\n");
	if (countTokens(fullPath) <= maxTokens * 0.5) return headings;

	const allowance = Math.max(0, Math.floor(maxTokens * 0.35) - 2 * (headings.length - 1));
	const perHeading = Math.floor(allowance / headings.length);
	if (perHeading < 3)
		return headings
			.slice(-1)
			.map((heading) => truncateTokens(heading, Math.max(1, maxTokens - 4), countTokens));
	return headings.map((heading) => {
		if (countTokens(heading) <= perHeading) return heading;
		const marker = heading.match(/^#{1,6}\s/)?.[0] ?? "";
		const title = heading.slice(marker.length);
		const titleTokens = Math.max(0, perHeading - countTokens(marker) - countTokens("…"));
		return `${truncateTokens(marker, perHeading, countTokens)}${truncateTokens(
			title,
			titleTokens,
			countTokens,
		)}…`;
	});
}

function flattenMarkdownTree(nodes: MarkdownNode[], headings: string[] = []): MarkdownEntry[] {
	const entries: MarkdownEntry[] = [];
	for (const node of nodes) {
		if (node.type === "section") {
			entries.push(...flattenMarkdownTree(node.children, [...headings, node.heading]));
		} else {
			entries.push({ headings, kind: node.kind, text: node.text });
		}
	}
	return entries;
}

export function chunkText(
	text: string,
	countTokens: TokenCounter,
	maxChunkTokens = config.embeddingMaxTokens,
): Chunk[] {
	const clean = text.replace(/\r\n/g, "\n").trim();
	if (!clean) return [];

	const chunks: Chunk[] = [];
	let currentHeadings: string[] | undefined;
	let currentBlocks: string[] = [];
	const render = (headings: string[], blocks: string[]) => {
		const context = fitHeadingPath(headings, maxChunkTokens, countTokens);
		return [...context, blocks.join("\n\n")].filter(Boolean).join("\n\n");
	};
	const entries = flattenMarkdownTree(parseMarkdownTree(clean)).flatMap((entry) => {
		const headingPrefix = render(entry.headings, []);
		let blockBudget = Math.max(1, maxChunkTokens - countTokens(headingPrefix) - 2);
		while (true) {
			const parts = splitBlock(entry.text, entry.kind, blockBudget, countTokens);
			if (parts.every((part) => countTokens(render(entry.headings, [part])) <= maxChunkTokens)) {
				return parts.map((part) => ({ ...entry, text: part }));
			}
			if (blockBudget <= 1) {
				throw new Error(
					`Impossible de découper un bloc sous le budget de ${maxChunkTokens} tokens.`,
				);
			}
			blockBudget = Math.max(1, blockBudget - Math.max(1, Math.ceil(maxChunkTokens * 0.05)));
		}
	});
	const flush = () => {
		if (currentHeadings && currentBlocks.length) {
			chunks.push({ text: render(currentHeadings, currentBlocks), chunkIndex: chunks.length });
		}
		currentBlocks = [];
	};

	for (const entry of entries) {
		if (currentHeadings && currentHeadings.join("\n") !== entry.headings.join("\n")) {
			flush();
			currentHeadings = undefined;
		}
		if (!currentHeadings) currentHeadings = entry.headings;

		const candidate = render(currentHeadings, [...currentBlocks, entry.text]);
		if (currentBlocks.length && countTokens(candidate) > maxChunkTokens) {
			flush();
			currentHeadings = entry.headings;
		}
		currentBlocks.push(entry.text);
	}
	flush();
	for (const chunk of chunks) {
		if (countTokens(chunk.text) > maxChunkTokens) {
			throw new Error(
				`Chunk ${chunk.chunkIndex} dépasse le budget maximal de ${maxChunkTokens} tokens.`,
			);
		}
	}
	return chunks;
}
