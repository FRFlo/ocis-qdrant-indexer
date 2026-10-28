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

	it("accepts an optional PaddleOCR service URL", () => {
		expect(
			loadConfig({
				PADDLEOCR_URL: "http://paddleocr:8080/",
				PADDLEOCR_TIMEOUT_MS: "600000",
			}),
		).toMatchObject({
			paddleOcrUrl: "http://paddleocr:8080",
			paddleOcrTimeoutMs: 600_000,
		});
		expect(loadConfig({})).toMatchObject({
			paddleOcrUrl: undefined,
			paddleOcrTimeoutMs: 300_000,
		});
	});

	it("configures Graph API and durable user credential storage", () => {
		expect(
			loadConfig({
				OCIS_WEBDAV_URL: "https://owncloud.example/remote.php/dav/files",
				OCIS_GRAPH_URL: "https://owncloud.example/graph/v1.0/",
				USER_STORE_PATH: "/var/lib/ocis-indexer/users.sqlite",
				USER_STORE_ENCRYPTION_KEY: "test-key",
			}),
		).toMatchObject({
			ocisGraphUrl: "https://owncloud.example/graph/v1.0",
			userStorePath: "/var/lib/ocis-indexer/users.sqlite",
			userStoreEncryptionKey: "test-key",
		});
	});

	it("does not expose legacy shared ownCloud credentials in configuration", () => {
		const configuration = loadConfig({
			OCIS_USERNAME: "admin",
			OCIS_PASSWORD: "old-password",
			OCIS_TOKEN: "old-token",
		});

		expect(configuration).not.toHaveProperty("ocisUsername");
		expect(configuration).not.toHaveProperty("ocisPassword");
		expect(configuration).not.toHaveProperty("ocisToken");
	});
});
