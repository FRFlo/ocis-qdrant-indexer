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
	});

	it("accepts an optional Tika server URL", () => {
		expect(loadConfig({ TIKA_URL: "http://tika:9998/" }).tikaUrl).toBe("http://tika:9998");
		expect(loadConfig({}).tikaUrl).toBeUndefined();
	});
});
