import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.ts";
import type { Embedder } from "./embedder.ts";
import type { OcisFileMetadata } from "./ocis.ts";
import type { Chunk } from "./parser.ts";

export interface QdrantTenantScope {
	tenantId: string;
	spaceId: string;
}

export interface QdrantSearchScope {
	tenantId: string;
	spaceIds: string[];
}

export class QdrantManager {
	public client: QdrantClient;
	private collection: string;
	private embedder: Embedder;

	constructor(embedder: Embedder) {
		this.embedder = embedder;
		this.collection = config.qdrantCollection;
		this.client = new QdrantClient({
			url: config.qdrantUrl,
			apiKey: config.qdrantApiKey,
		});
	}

	async ensureCollection(tenantId: string): Promise<void> {
		const collection = this.collectionFor(tenantId);
		const collections = await this.client.getCollections();
		const exists = collections.collections.some((c) => c.name === collection);

		if (!exists) {
			await this.client.createCollection(collection, {
				vectors: {
					size: this.embedder.dimensions(),
					distance: "Cosine",
				},
			});

			// Indexation du champ path pour des suppressions rapides
			await this.client.createPayloadIndex(collection, {
				field_name: "path",
				field_schema: "keyword",
			});
			await this.client.createPayloadIndex(collection, {
				field_name: "node_id",
				field_schema: "keyword",
			});
			await this.client.createPayloadIndex(collection, {
				field_name: "space_id",
				field_schema: "keyword",
			});
		}
	}

	async deleteSpaceVectors(tenantId: string, spaceId: string): Promise<void> {
		await this.client.delete(this.collectionFor(tenantId), {
			filter: { must: [{ key: "space_id", match: { value: spaceId } }] },
			wait: true,
		});
	}

	async deleteFileVectors(path: string, scope: QdrantTenantScope): Promise<void> {
		await this.client.delete(this.collectionFor(scope.tenantId), {
			filter: this.pathFilter(path, scope),
			wait: true,
		});
	}

	async hasCurrentContentHash(
		path: string,
		contentHash: string,
		scope: QdrantTenantScope,
	): Promise<boolean> {
		const { points } = await this.client.scroll(this.collectionFor(scope.tenantId), {
			filter: this.pathFilter(path, scope),
			limit: 1,
			with_payload: ["content_hash"],
			with_vector: false,
		});
		return points[0]?.payload?.content_hash === contentHash;
	}

	async updateFileMetadata(
		path: string,
		metadata: OcisFileMetadata,
		scope: QdrantTenantScope,
	): Promise<void> {
		const payload = Object.fromEntries(
			Object.entries(metadata).filter(
				([key, value]) =>
					key !== "path" &&
					key !== "space_id" &&
					key !== "tenant_id" &&
					value !== undefined &&
					value !== "",
			),
		);
		if (Object.keys(payload).length === 0) return;
		await this.client.setPayload(this.collectionFor(scope.tenantId), {
			payload,
			filter: this.pathFilter(path, scope),
			wait: true,
		});
	}

	async reuseContentHash(
		path: string,
		nodeId: string,
		contentHash: string,
		metadata: OcisFileMetadata,
		scope: QdrantTenantScope,
		source = "ownCloud",
	): Promise<boolean> {
		const collection = this.collectionFor(scope.tenantId);
		const filter: Record<string, unknown> = {
			must: [
				{ key: "content_hash", match: { value: contentHash } },
				{ key: "space_id", match: { value: scope.spaceId } },
			],
		};
		const { points } = await this.client.scroll(collection, {
			filter,
			limit: 256,
			with_payload: true,
			with_vector: true,
		});
		if (points.length === 0 || points.some((point) => !point.vector)) return false;
		const copied = points.map((point) => {
			const old = point.payload ?? {};
			return {
				id: this.pointId(path, Number(old.chunk_index ?? 0), scope.spaceId),
				vector: point.vector as number[],
				payload: {
					...old,
					...metadata,
					path,
					space_id: scope.spaceId,
					node_id: nodeId,
					filename: path.split("/").pop() || "",
					content_hash: contentHash,
					source,
					indexed_at: new Date().toISOString(),
				},
			};
		});
		await this.client.upsert(collection, { wait: true, points: copied });
		await this.client.delete(collection, {
			filter: {
				...this.pathFilter(path, scope),
				must_not: [{ has_id: copied.map((point) => point.id) }],
			},
			wait: true,
		});
		return true;
	}

	async hasIndexedPath(path: string, scope: QdrantTenantScope): Promise<boolean> {
		const { points } = await this.client.scroll(this.collectionFor(scope.tenantId), {
			filter: this.pathFilter(path, scope),
			limit: 1,
			with_payload: false,
			with_vector: false,
		});
		return points.length > 0;
	}

	async listIndexedPaths(scope: QdrantTenantScope): Promise<string[]> {
		const paths = new Set<string>();
		let offset: string | number | undefined;
		do {
			const page = await this.client.scroll(this.collectionFor(scope.tenantId), {
				limit: 256,
				offset,
				filter: { must: [{ key: "space_id", match: { value: scope.spaceId } }] },
				with_payload: ["path"],
				with_vector: false,
			});
			for (const point of page.points) {
				if (typeof point.payload?.path === "string") paths.add(point.payload.path);
			}
			offset = page.next_page_offset as string | number | undefined;
		} while (offset !== undefined && offset !== null);
		return [...paths];
	}

	async indexChunks(
		path: string,
		nodeId: string,
		chunks: Chunk[],
		contentHash: string,
		scope: QdrantTenantScope,
		metadata: OcisFileMetadata = { webdav_url: "" },
		source = "ownCloud",
	): Promise<number> {
		if (chunks.length === 0) return 0;

		// Generate all embeddings before changing the current index. A provider
		// failure must not make an already indexed document disappear.
		const texts = chunks.map((c) => c.text);
		const vectors = await this.embedder.embed(texts);
		if (
			vectors.length !== chunks.length ||
			vectors.some((vector) => vector.length !== this.embedder.dimensions())
		) {
			throw new Error(`Réponse embeddings invalide pour ${path}`);
		}

		// Upsert first, then remove stale points. Deterministic IDs allow the
		// cleanup filter to preserve exactly the newly indexed points.
		const points = chunks.map((chunk, idx) => ({
			id: this.pointId(path, chunk.chunkIndex, scope.spaceId),
			vector: vectors[idx]!,
			payload: {
				...metadata,
				path,
				space_id: scope.spaceId,
				node_id: nodeId,
				filename: path.split("/").pop() || "",
				chunk_index: chunk.chunkIndex,
				content_hash: contentHash,
				source,
				text: chunk.text,
				indexed_at: new Date().toISOString(),
			},
		}));

		const collection = this.collectionFor(scope.tenantId);
		await this.client.upsert(collection, {
			wait: true,
			points,
		});
		await this.client.delete(collection, {
			filter: {
				...this.pathFilter(path, scope),
				must_not: [{ has_id: points.map((point) => point.id) }],
			},
			wait: true,
		});

		return points.length;
	}

	private pathVariants(path: string): string[] {
		const canonical = path
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment && segment !== ".")
			.join("/");
		return [...new Set([canonical, `/${canonical}`, `./${canonical}`])];
	}

	private pathFilter(path: string, scope: QdrantTenantScope): Record<string, unknown> {
		return {
			should: this.pathVariants(path).map((value) => ({
				key: "path",
				match: { value },
			})),
			must: [{ key: "space_id", match: { value: scope.spaceId } }],
		};
	}

	private collectionFor(tenantId: string): string {
		if (!/^[a-f0-9]{32}$/.test(tenantId)) {
			throw new Error("Identifiant de tenant Qdrant invalide.");
		}
		return `${this.collection}_${tenantId}`;
	}

	private pointId(path: string, chunkIndex: number, spaceId: string): string {
		// Qdrant accepts UUID point IDs. Hashing keeps chunk IDs stable between
		// retries while avoiding collisions between files.
		const hash = new Bun.CryptoHasher("sha256")
			.update(`${spaceId}\0${path}\0${chunkIndex}`)
			.digest();
		const bytes = new Uint8Array(16);
		for (let i = 0; i < bytes.length; i++) bytes[i] = hash[i]!;
		bytes[6] = (bytes[6]! & 0x0f) | 0x50;
		bytes[8] = (bytes[8]! & 0x3f) | 0x80;
		const hex = Buffer.from(bytes).toString("hex");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}

	async search(
		query: string,
		limit: number,
		pathPrefix: string | undefined,
		scope: QdrantSearchScope,
	) {
		if (scope.spaceIds.length === 0) return [];
		const [queryVector] = await this.embedder.embed([query]);
		if (!queryVector) {
			throw new Error("Impossible de générer l'embedding pour la requête");
		}

		const must: Record<string, unknown>[] = [];
		must.push({ key: "space_id", match: { any: scope.spaceIds } });
		if (pathPrefix) {
			must.push({ key: "path", match: { text: pathPrefix } });
		}

		const { points } = await this.client.query(this.collectionFor(scope.tenantId), {
			query: queryVector,
			limit: Math.max(1, Math.min(Math.trunc(limit), 100)),
			filter: must.length > 0 ? { must } : undefined,
			with_payload: true,
		});

		return points.map((r) => ({
			score: r.score,
			path: r.payload?.path as string,
			filename: r.payload?.filename as string,
			text: r.payload?.text as string,
			chunkIndex: r.payload?.chunk_index as number,
			webdavUrl: r.payload?.webdav_url as string,
			ocisUrl: r.payload?.ocis_url as string | undefined,
			lastModified: r.payload?.last_modified as string | undefined,
			createdAt: r.payload?.created_at as string | undefined,
			sizeBytes: r.payload?.size_bytes as number | undefined,
			contentType: r.payload?.content_type as string | undefined,
			etag: r.payload?.etag as string | undefined,
			source: (r.payload?.source as string | undefined) || "unknown",
		}));
	}
}
