import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userScopeId } from "./auth.ts";
import type { OcisClient, OcisUserContext } from "./ocis.ts";
import type { QdrantManager } from "./qdrant.ts";
import { UserCredentialStore } from "./user-store.ts";
import { UserIndexer } from "./user-indexer.ts";

const directories: string[] = [];
const stores: UserCredentialStore[] = [];

afterEach(async () => {
	for (const store of stores.splice(0)) store.close();
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function makeStore() {
	const directory = await mkdtemp(join(tmpdir(), "ocis-user-indexer-"));
	directories.push(directory);
	const store = new UserCredentialStore(
		join(directory, "users.sqlite"),
		Buffer.alloc(32, 9).toString("base64"),
	);
	stores.push(store);
	return store;
}

describe("UserIndexer", () => {
	it("starts one background initial sync on first authentication only", async () => {
		const store = await makeStore();
		const context: OcisUserContext = {
			userId: "first-login-id",
			username: "first-login",
			drives: [],
		};
		const clientFactory = () =>
			({
				getUserContext: mock(async () => context),
				forDrive: mock(() => ({ listFiles: mock(async () => []) })),
			}) as unknown as OcisClient;
		const ensureCollection = mock(async () => undefined);
		const indexer = new UserIndexer(
			{ ensureCollection } as unknown as QdrantManager,
			store,
			clientFactory,
		);

		await Promise.all([
			indexer.authenticate({ username: "first-login", pat: "secret-pat" }),
			indexer.authenticate({ username: "first-login", pat: "secret-pat" }),
		]);
		await Promise.resolve();

		expect(ensureCollection).toHaveBeenCalledTimes(1);
		expect(store.get(context.userId)?.pat).toBe("secret-pat");
	});

	it("indexes the same relative path into each user's own space and collection", async () => {
		const store = await makeStore();
		const contexts: Record<string, OcisUserContext> = {
			alice: {
				userId: "alice-id",
				username: "alice",
				drives: [{ id: "alice-drive", name: "Alice", driveType: "personal" }],
			},
			bob: {
				userId: "bob-id",
				username: "bob",
				drives: [{ id: "bob-drive", name: "Bob", driveType: "personal" }],
			},
		};
		const clientFactory = (credentials: { username: string; pat: string }) => {
			const context = contexts[credentials.username]!;
			return {
				getUserContext: mock(async () => context),
				forDrive: mock(() => ({
					listFiles: mock(async () => ["Notes/plan.md"]),
					getFileMetadata: mock(async () => ({
						webdav_url: `https://owncloud.example/dav/spaces/${context.drives[0]?.id}/Notes/plan.md`,
					})),
					downloadFile: mock(async () => Buffer.from(`${credentials.username} private content`)),
				})),
			} as unknown as OcisClient;
		};
		const indexed: Array<{
			tenantId: string;
			spaceId: string;
			path: string;
			text: string;
		}> = [];
		const qdrant = {
			ensureCollection: mock(async () => undefined),
			listIndexedPaths: mock(async () => []),
			hasCurrentContentHash: mock(async () => false),
			indexChunks: mock(
				async (
					path: string,
					_nodeId: string,
					chunks: Array<{ text: string; chunkIndex: number }>,
					_hash: string,
					scope: { tenantId: string; spaceId: string },
					_metadata: unknown,
					_source: string,
				) => {
					indexed.push({
						tenantId: scope.tenantId,
						spaceId: scope.spaceId,
						path,
						text: chunks.map((chunk) => chunk.text).join(" "),
					});
					return chunks.length;
				},
			),
			deleteFileVectors: mock(async () => undefined),
		} as unknown as QdrantManager;
		const indexer = new UserIndexer(
			qdrant,
			store,
			clientFactory,
			async () => (text) => Array.from(text).length,
		);

		await indexer.sync({ username: "alice", pat: "alice-pat" });
		await indexer.sync({ username: "bob", pat: "bob-pat" });

		expect(indexed).toHaveLength(2);
		expect(indexed).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					tenantId: userScopeId("alice-id"),
					spaceId: "alice-drive",
					path: "Notes/plan.md",
				}),
				expect.objectContaining({
					tenantId: userScopeId("bob-id"),
					spaceId: "bob-drive",
					path: "Notes/plan.md",
				}),
			]),
		);
		expect(indexed[0]?.text).toContain("private content");
		expect(indexed[0]?.text).not.toBe(indexed[1]?.text);
		expect(store.list()).toHaveLength(2);
	});

	it("searches only within the authenticated user's currently accessible spaces", async () => {
		const store = await makeStore();
		const context: OcisUserContext = {
			userId: "alice-id",
			username: "alice",
			drives: [{ id: "alice-drive", name: "Alice", driveType: "personal" }],
		};
		const clientFactory = () =>
			({
				getUserContext: mock(async () => context),
				forDrive: mock(() => ({ listFiles: mock(async () => []) })),
			}) as unknown as OcisClient;
		const search = mock(async () => []);
		const qdrant = {
			ensureCollection: mock(async () => undefined),
			listIndexedPaths: mock(async () => []),
			deleteSpaceVectors: mock(async () => undefined),
			search,
		} as unknown as QdrantManager;
		const indexer = new UserIndexer(qdrant, store, clientFactory);

		await indexer.search({ username: "alice", pat: "alice-pat" }, "query", 5);

		expect(search).toHaveBeenCalledWith("query", 5, undefined, {
			tenantId: userScopeId("alice-id"),
			spaceIds: ["alice-drive"],
		});
	});

	it("does not delete indexed paths when a drive scan unexpectedly returns empty", async () => {
		const store = await makeStore();
		const context: OcisUserContext = {
			userId: "alice-id",
			username: "alice",
			drives: [{ id: "alice-drive", name: "Alice", driveType: "personal" }],
		};
		store.save({
			userId: context.userId,
			username: context.username,
			pat: "alice-pat",
			drives: context.drives,
		});
		const deleteFileVectors = mock(async () => undefined);
		const qdrant = {
			ensureCollection: mock(async () => undefined),
			listIndexedPaths: mock(async () => ["Notes/existing.md"]),
			deleteFileVectors,
		} as unknown as QdrantManager;
		const clientFactory = () =>
			({
				getUserContext: mock(async () => context),
				forDrive: mock(() => ({ listFiles: mock(async () => []) })),
			}) as unknown as OcisClient;
		const indexer = new UserIndexer(qdrant, store, clientFactory);

		await indexer.sync({ username: "alice", pat: "alice-pat" });

		expect(deleteFileVectors).not.toHaveBeenCalled();
	});

	it("returns immediately before sync authentication and scanning complete", async () => {
		const store = await makeStore();
		const clientFactory = () =>
			({
				getUserContext: mock(() => new Promise<OcisUserContext>(() => {})),
			}) as unknown as OcisClient;
		const indexer = new UserIndexer({} as QdrantManager, store, clientFactory);

		const started = indexer.startSync({ username: "alice", pat: "alice-pat" });
		const duplicate = indexer.startSync({ username: "alice", pat: "alice-pat" });

		expect(started).toEqual({ status: "started" });
		expect(duplicate).toEqual({ status: "already_running" });
	});

	it("routes a NATS event only to users authorized for its SpaceId", async () => {
		const store = await makeStore();
		const contexts: Record<string, OcisUserContext> = {
			alice: {
				userId: "alice-id",
				username: "alice",
				drives: [{ id: "alice-drive", name: "Alice", driveType: "personal" }],
			},
			bob: {
				userId: "bob-id",
				username: "bob",
				drives: [{ id: "bob-drive", name: "Bob", driveType: "personal" }],
			},
		};
		store.save({
			userId: "alice-id",
			username: "alice",
			pat: "alice-pat",
			drives: contexts.alice!.drives,
		});
		store.save({
			userId: "bob-id",
			username: "bob",
			pat: "bob-pat",
			drives: contexts.bob!.drives,
		});
		const indexed: Array<{ username: string; scope: { tenantId: string; spaceId: string } }> = [];
		const clientFactory = (credentials: { username: string }) =>
			({
				getUserContext: mock(async () => contexts[credentials.username]!),
				forDrive: mock(() => ({
					getFileMetadata: mock(async () => ({
						webdav_url: "https://owncloud.example/dav/spaces/alice-drive/Notes/plan.md",
					})),
					downloadFile: mock(async () => Buffer.from("# Alice only\n\nAlice's content")),
				})),
			}) as unknown as OcisClient;
		const qdrant = {
			hasCurrentContentHash: mock(async () => false),
			indexChunks: mock(
				async (
					_path: string,
					_nodeId: string,
					_chunks: unknown[],
					_hash: string,
					scope: { tenantId: string; spaceId: string },
					_metadata: unknown,
					_source: string,
				) => {
					indexed.push({
						username: scope.tenantId === userScopeId("alice-id") ? "alice" : "bob",
						scope,
					});
				},
			),
		} as unknown as QdrantManager;
		const indexer = new UserIndexer(
			qdrant,
			store,
			clientFactory,
			async () => (text) => text.length,
		);

		await indexer.handleEvent("events.FileUploaded", {
			FileRef: {
				path: "./Notes/plan.md",
				resource_id: { space_id: "alice-drive", opaque_id: "doc-1" },
			},
		});

		expect(indexed).toEqual([
			{
				username: "alice",
				scope: { tenantId: userScopeId("alice-id"), spaceId: "alice-drive" },
			},
		]);
	});

	it("reconciles registered users instead of routing a path-only event", async () => {
		const store = await makeStore();
		const indexer = new UserIndexer({} as QdrantManager, store, () => ({}) as OcisClient);
		const reconcile = mock(async () => undefined);
		indexer.syncRegisteredUsers = reconcile;

		await indexer.handleEvent("events.ItemPurged", {
			Ref: { Path: "Notes/plan.md" },
		});

		expect(reconcile).toHaveBeenCalledTimes(1);
	});
});
