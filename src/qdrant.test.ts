import { describe, expect, it, mock } from "bun:test";
import type { Embedder } from "./embedder.ts";
import { QdrantManager } from "./qdrant.ts";

describe("QdrantManager", () => {
	it("keeps existing vectors untouched when embedding generation fails", async () => {
		const embedder: Embedder = {
			embed: mock(async () => {
				throw new Error("provider unavailable");
			}),
			dimensions: () => 2,
		};
		const manager = new QdrantManager(embedder);
		const client = {
			delete: mock(async () => undefined),
			upsert: mock(async () => undefined),
		};
		manager.client = client as unknown as typeof manager.client;

		await expect(
			manager.indexChunks("notes/page.md", "node-1", [{ text: "content", chunkIndex: 0 }]),
		).rejects.toThrow("provider unavailable");
		expect(client.delete).not.toHaveBeenCalled();
		expect(client.upsert).not.toHaveBeenCalled();
	});
});
