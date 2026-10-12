import { convert } from "@opendataloader/pdf";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
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

function byteLength(text: string): number {
	// The UTF-8 byte ceiling is a conservative, tokenizer-independent proxy for input tokens.
	return Buffer.byteLength(text, "utf8");
}

function splitWords(text: string, maxBytes: number): string[] {
	const chunks: string[] = [];
	let current = "";
	for (const word of text.split(/(\s+)/u).filter(Boolean)) {
		if (byteLength(word) > maxBytes) {
			if (current.trim()) chunks.push(current.trim());
			current = "";
			let part = "";
			for (const character of Array.from(word)) {
				if (part && byteLength(part + character) > maxBytes) {
					chunks.push(part);
					part = "";
				}
				part += character;
			}
			if (part) current = part;
			continue;
		}
		if (current && byteLength(current + word) > maxBytes) {
			chunks.push(current.trim());
			current = word.trimStart();
		} else {
			current += word;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks;
}

function splitSentences(text: string, maxBytes: number): string[] {
	const sentences = text
		.split(/(?<=[.!?。！？])\s+/u)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const chunks: string[] = [];
	let current = "";
	for (const sentence of sentences) {
		const parts = byteLength(sentence) > maxBytes ? splitWords(sentence, maxBytes) : [sentence];
		for (const part of parts) {
			if (current && byteLength(`${current} ${part}`) > maxBytes) {
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

function splitCode(text: string, maxBytes: number): string[] {
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
	const bodyBudget = maxBytes - byteLength(wrapper);
	if (bodyBudget < 1) return splitSentences(text, maxBytes);

	const chunks: string[] = [];
	let current = "";
	for (const line of lines) {
		const parts = byteLength(line) > bodyBudget ? splitSentences(line, bodyBudget) : [line];
		for (const part of parts) {
			if (current && byteLength(`${current}\n${part}`) > bodyBudget) {
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

function splitTable(text: string, maxBytes: number): string[] {
	const lines = text.split("\n");
	if (lines.length < 3) return splitSentences(text, maxBytes);
	const header = lines.slice(0, 2).join("\n");
	const rowBudget = maxBytes - byteLength(`${header}\n\n`);
	if (rowBudget < 1) return splitSentences(text, maxBytes);

	const chunks: string[] = [];
	let rows: string[] = [];
	const flush = () => {
		if (rows.length) chunks.push(`${header}\n${rows.join("\n")}`);
		rows = [];
	};
	for (const row of lines.slice(2)) {
		if (byteLength(row) > rowBudget) {
			flush();
			for (const part of splitSentences(row, rowBudget)) chunks.push(`${header}\n${part}`);
			continue;
		}
		if (rows.length && byteLength([...rows, row].join("\n")) > rowBudget) flush();
		rows.push(row);
	}
	flush();
	return chunks.length ? chunks : splitSentences(text, maxBytes);
}

function splitBlock(text: string, kind: string, maxBytes: number): string[] {
	if (byteLength(text) <= maxBytes) return [text];
	if (kind === "code") return splitCode(text, maxBytes);
	if (kind === "table") return splitTable(text, maxBytes);
	if (kind === "list") {
		return text
			.split("\n")
			.flatMap((line) => splitSentences(line, maxBytes))
			.filter(Boolean);
	}
	return text
		.split(/\n+/)
		.flatMap((line) => splitSentences(line, maxBytes))
		.filter(Boolean);
}

function truncateUtf8(text: string, maxBytes: number): string {
	let result = "";
	for (const character of Array.from(text)) {
		if (byteLength(result + character) > maxBytes) break;
		result += character;
	}
	return result;
}

function fitHeadingPath(headings: string[], maxBytes: number): string[] {
	if (!headings.length) return headings;
	const fullPath = headings.join("\n\n");
	if (byteLength(fullPath) + 2 <= maxBytes * 0.5) return headings;

	const allowance = Math.max(0, Math.floor(maxBytes * 0.35) - 2 * (headings.length - 1));
	const perHeading = Math.floor(allowance / headings.length);
	if (perHeading < 3)
		return headings.slice(-1).map((heading) => truncateUtf8(heading, Math.max(1, maxBytes - 4)));
	return headings.map((heading) => {
		if (byteLength(heading) <= perHeading) return heading;
		const marker = heading.match(/^#{1,6}\s/)?.[0] ?? "";
		const title = heading.slice(marker.length);
		const titleBytes = Math.max(0, perHeading - byteLength(marker) - byteLength("…"));
		return `${truncateUtf8(marker, perHeading)}${truncateUtf8(title, titleBytes)}…`;
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

export function chunkText(text: string, maxChunkTokens = config.embeddingMaxTokens): Chunk[] {
	const clean = text.replace(/\r\n/g, "\n").trim();
	if (!clean) return [];

	const chunks: Chunk[] = [];
	let currentHeadings: string[] | undefined;
	let currentBlocks: string[] = [];
	const render = (headings: string[], blocks: string[]) => {
		const context = fitHeadingPath(headings, maxChunkTokens);
		return [...context, blocks.join("\n\n")].filter(Boolean).join("\n\n");
	};
	const entries = flattenMarkdownTree(parseMarkdownTree(clean)).flatMap((entry) => {
		const headingPrefix = render(entry.headings, []);
		const headingSeparatorBytes = headingPrefix ? 2 : 0;
		const blockBudget = Math.max(
			1,
			maxChunkTokens - byteLength(headingPrefix) - headingSeparatorBytes,
		);
		return splitBlock(entry.text, entry.kind, blockBudget).map((part) => ({
			...entry,
			text: part,
		}));
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
		if (currentBlocks.length && byteLength(candidate) > maxChunkTokens) {
			flush();
			currentHeadings = entry.headings;
		}
		currentBlocks.push(entry.text);
	}
	flush();
	return chunks;
}
