import { describe, expect, it, mock } from "bun:test";
import type { Embedder } from "./embedder.ts";
import { QdrantManager } from "./qdrant.ts";

describe("QdrantManager", () => {
	it("persists the source content hash on indexed chunks", async () => {
		const embedder: Embedder = {
			embed: mock(async () => [[0.1, 0.2]]),
			dimensions: () => 2,
		};
		const manager = new QdrantManager(embedder);
		const upsert = mock(
			async (
				_collection: string,
				request: { points: Array<{ payload: Record<string, unknown> }> },
			) => {
				expect(request.points[0]?.payload.content_hash).toBe("content-sha");
			},
		);
		manager.client = {
			upsert,
			delete: mock(async () => undefined),
		} as unknown as typeof manager.client;

		await manager.indexChunks(
			"notes/page.md",
			"node-1",
			[{ text: "content", chunkIndex: 0 }],
			"content-sha",
		);

		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it("checks the stored hash for a file before re-embedding", async () => {
		const embedder: Embedder = {
			embed: mock(async () => []),
			dimensions: () => 2,
		};
		const manager = new QdrantManager(embedder);
		const scroll = mock(async () => ({
			points: [{ payload: { content_hash: "same-content" } }],
		}));
		manager.client = { scroll } as unknown as typeof manager.client;

		await expect(manager.hasCurrentContentHash("notes/page.md", "same-content")).resolves.toBe(
			true,
		);
		expect(scroll).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ limit: 1, with_payload: ["content_hash"], with_vector: false }),
		);
	});

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
			manager.indexChunks(
				"notes/page.md",
				"node-1",
				[{ text: "content", chunkIndex: 0 }],
				"content-sha",
			),
		).rejects.toThrow("provider unavailable");
		expect(client.delete).not.toHaveBeenCalled();
		expect(client.upsert).not.toHaveBeenCalled();
	});
});
