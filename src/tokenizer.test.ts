import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { chunkText } from "./parser.ts";
import { createEmbeddingTokenCounter, createHuggingFaceTokenCounter } from "./tokenizer.ts";

const testCacheDirs: string[] = [];

async function makeCacheDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ocis-tokenizer-test-"));
	testCacheDirs.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(testCacheDirs.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const tokenizerJson = {
	version: "1.0",
	truncation: null,
	padding: null,
	added_tokens: [],
	normalizer: {
		type: "BertNormalizer",
		clean_text: true,
		handle_chinese_chars: true,
		strip_accents: null,
		lowercase: true,
	},
	pre_tokenizer: { type: "BertPreTokenizer" },
	post_processor: {
		type: "BertProcessing",
		sep: ["[SEP]", 3],
		cls: ["[CLS]", 2],
	},
	decoder: null,
	model: {
		type: "WordPiece",
		unk_token: "[UNK]",
		continuing_subword_prefix: "##",
		max_input_chars_per_word: 100,
		vocab: {
			"[PAD]": 0,
			"[UNK]": 1,
			"[CLS]": 2,
			"[SEP]": 3,
			hello: 4,
			world: 5,
		},
	},
};

const tokenizerConfig = {
	unk_token: "[UNK]",
	sep_token: "[SEP]",
	pad_token: "[PAD]",
	cls_token: "[CLS]",
	mask_token: "[MASK]",
};

function mockHuggingFaceFetch() {
	const calls: string[] = [];
	const fetcher = async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		return new Response(
			JSON.stringify(url.endsWith("tokenizer.json") ? tokenizerJson : tokenizerConfig),
		);
	};
	return { fetcher: fetcher as typeof fetch, calls };
}

describe("embedding token counter", () => {
	it("uses OpenAI's cl100k_base encoding for text-embedding-3-small", async () => {
		const countTokens = await createEmbeddingTokenCounter(
			loadConfig({ EMBEDDING_PROVIDER: "openai" }),
		);

		expect(countTokens("Hello, world!")).toBe(4);
	});

	it("counts Hugging Face tokens including model special tokens", async () => {
		const { fetcher, calls } = mockHuggingFaceFetch();
		const countTokens = await createHuggingFaceTokenCounter(
			"org/test-model",
			"test-revision",
			await makeCacheDir(),
			fetcher,
		);

		expect(countTokens("hello world")).toBe(4);
		expect(calls).toHaveLength(2);
	});

	it("keeps rendered chunks under the tokenizer's exact token budget", async () => {
		const countTokens = await createHuggingFaceTokenCounter(
			"org/test-model",
			"revision",
			await makeCacheDir(),
			mockHuggingFaceFetch().fetcher,
		);
		const document = `# Guide\n\n${"hello world\n\n".repeat(12)}`;
		const chunks = chunkText(document, countTokens, 12);

		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.every((chunk) => countTokens(chunk.text) <= 12)).toBe(true);
	});

	it("selects the pinned official BGE-M3 tokenizer for Cloudflare", async () => {
		const { fetcher, calls } = mockHuggingFaceFetch();
		const countTokens = await createEmbeddingTokenCounter(
			loadConfig({
				EMBEDDING_PROVIDER: "cloudflare",
				EMBEDDING_TOKENIZER_CACHE_DIR: await makeCacheDir(),
			}),
			fetcher,
		);

		expect(countTokens("hello world")).toBe(4);
		expect(calls.every((url) => url.includes("BAAI/bge-m3/resolve/"))).toBe(true);
		expect(calls.every((url) => url.includes("5617a9f61b028005a4858fdac845db406aefb181"))).toBe(
			true,
		);
	});

	it("rejects models without a known official tokenizer", async () => {
		const customOpenAi = loadConfig({
			EMBEDDING_PROVIDER: "openai",
			OPENAI_MODEL: "custom-embedding",
		});

		await expect(createEmbeddingTokenCounter(customOpenAi)).rejects.toThrow(
			"EMBEDDING_TOKENIZER_MODEL",
		);
	});
});
