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
				expect(request.points[0]?.payload.source).toBe("ownCloud");
				expect(request.points[0]?.payload.webdav_url).toBe(
					"https://owncloud.example/dav/spaces/space/notes/page.md",
				);
				expect(request.points[0]?.payload.last_modified).toBe("Wed, 01 Jan 2025 12:00:00 GMT");
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
			{ tenantId: "a".repeat(32), spaceId: "drive-a" },
			{
				webdav_url: "https://owncloud.example/dav/spaces/space/notes/page.md",
				last_modified: "Wed, 01 Jan 2025 12:00:00 GMT",
			},
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

		await expect(
			manager.hasCurrentContentHash("notes/page.md", "same-content", {
				tenantId: "a".repeat(32),
				spaceId: "drive-a",
			}),
		).resolves.toBe(true);
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
				{ tenantId: "a".repeat(32), spaceId: "drive-a" },
			),
		).rejects.toThrow("provider unavailable");
		expect(client.delete).not.toHaveBeenCalled();
		expect(client.upsert).not.toHaveBeenCalled();
	});

	it("searches only the authenticated user's collection and accessible spaces", async () => {
		const embedder: Embedder = {
			embed: mock(async () => [[0.1, 0.2]]),
			dimensions: () => 2,
		};
		const manager = new QdrantManager(embedder);
		const query = mock(async () => ({ points: [] }));
		manager.client = { query } as unknown as typeof manager.client;

		await manager.search("private query", 5, undefined, {
			tenantId: "a".repeat(32),
			spaceIds: ["alice-drive", "shared-drive"],
		});

		expect(query).toHaveBeenCalledWith(
			"owncloud_documents_" + "a".repeat(32),
			expect.objectContaining({
				filter: {
					must: [
						{
							key: "space_id",
							match: { any: ["alice-drive", "shared-drive"] },
						},
					],
				},
			}),
		);
	});

	it("writes user and space scoped chunks into an isolated collection", async () => {
		const embedder: Embedder = {
			embed: mock(async () => [[0.1, 0.2]]),
			dimensions: () => 2,
		};
		const manager = new QdrantManager(embedder);
		const upsert = mock(
			async (
				collection: string,
				request: { points: Array<{ id: string; payload: Record<string, unknown> }> },
			) => {
				expect(collection).toBe("owncloud_documents_" + "b".repeat(32));
				expect(request.points[0]?.payload.space_id).toBe("bob-drive");
			},
		);
		manager.client = {
			upsert,
			delete: mock(async () => undefined),
		} as unknown as typeof manager.client;

		await manager.indexChunks(
			"notes/page.md",
			"node-1",
			[{ text: "Bob private content", chunkIndex: 0 }],
			"content-sha",
			{ tenantId: "b".repeat(32), spaceId: "bob-drive" },
			{ webdav_url: "https://owncloud/dav/spaces/bob-drive/notes/page.md" },
			"ownCloud",
		);

		expect(upsert).toHaveBeenCalledTimes(1);
	});

	it("refuses to query a user collection without currently authorized spaces", async () => {
		const embed = mock(async () => [[0.1, 0.2]]);
		const manager = new QdrantManager({ embed, dimensions: () => 2 });
		const query = mock(async () => ({ points: [] }));
		manager.client = { query } as unknown as typeof manager.client;

		await expect(
			manager.search("query", 5, undefined, {
				tenantId: "c".repeat(32),
				spaceIds: [],
			}),
		).resolves.toEqual([]);
		expect(embed).not.toHaveBeenCalled();
		expect(query).not.toHaveBeenCalled();
	});

	it("deletes only the target user's vectors from the target space", async () => {
		const manager = new QdrantManager({ embed: mock(async () => []), dimensions: () => 2 });
		const remove = mock(async () => undefined);
		manager.client = { delete: remove } as unknown as typeof manager.client;

		await manager.deleteSpaceVectors("d".repeat(32), "drive-alice");

		expect(remove).toHaveBeenCalledWith("owncloud_documents_" + "d".repeat(32), {
			filter: { must: [{ key: "space_id", match: { value: "drive-alice" } }] },
			wait: true,
		});
	});
});
