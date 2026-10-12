import { describe, expect, it } from "bun:test";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
	it("rejects unknown embedding providers and invalid ports", () => {
		expect(() => loadConfig({ EMBEDDING_PROVIDER: "other" })).toThrow(
			"EMBEDDING_PROVIDER invalide",
		);
		expect(() => loadConfig({ MCP_PORT: "0" })).toThrow("MCP_PORT doit être un entier positif");
		expect(() => loadConfig({ MCP_PORT: "70000" })).toThrow("compris entre 1 et 65535");
	});

	it("provides bounded WebDAV request defaults", () => {
		const config = loadConfig({ EMBEDDING_PROVIDER: "ollama" });
		expect(config.ocisRequestTimeoutMs).toBe(30_000);
		expect(config.ocisMaxFileSizeBytes).toBe(50 * 1024 * 1024);
		expect(config.embeddingMaxTokens).toBe(7_000);
		expect(config.indexConcurrency).toBe(4);
	});

	it("accepts a custom embedding input token budget", () => {
		expect(loadConfig({ EMBEDDING_MAX_TOKENS: "512" }).embeddingMaxTokens).toBe(512);
		expect(() => loadConfig({ EMBEDDING_MAX_TOKENS: "0" })).toThrow("EMBEDDING_MAX_TOKENS");
		expect(() => loadConfig({ EMBEDDING_MAX_TOKENS: "3" })).toThrow("au moins égal à 4");
	});

	it("accepts an explicit Hugging Face tokenizer and cache location", () => {
		const config = loadConfig({
			EMBEDDING_TOKENIZER_MODEL: " org/model ",
			EMBEDDING_TOKENIZER_REVISION: " revision ",
			EMBEDDING_TOKENIZER_CACHE_DIR: "/tmp/tokenizers",
		});
		expect(config.embeddingTokenizerModel).toBe("org/model");
		expect(config.embeddingTokenizerRevision).toBe("revision");
		expect(config.embeddingTokenizerCacheDir).toBe("/tmp/tokenizers");
	});

	it("accepts an optional Tika server URL", () => {
		expect(loadConfig({ TIKA_URL: "http://tika:9998/" }).tikaUrl).toBe("http://tika:9998");
		expect(loadConfig({}).tikaUrl).toBeUndefined();
	});
});
