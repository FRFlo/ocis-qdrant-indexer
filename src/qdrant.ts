import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.ts";
import type { Embedder } from "./embedder.ts";
import type { OcisFileMetadata } from "./ocis.ts";
import type { Chunk } from "./parser.ts";

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

	async ensureCollection(): Promise<void> {
		const collections = await this.client.getCollections();
		const exists = collections.collections.some((c) => c.name === this.collection);

		if (!exists) {
			console.log(
				`[Qdrant] Création de la collection "${this.collection}" (dim: ${this.embedder.dimensions()})...`,
			);
			await this.client.createCollection(this.collection, {
				vectors: {
					size: this.embedder.dimensions(),
					distance: "Cosine",
				},
			});

			// Indexation du champ path pour des suppressions rapides
			await this.client.createPayloadIndex(this.collection, {
				field_name: "path",
				field_schema: "keyword",
			});
			await this.client.createPayloadIndex(this.collection, {
				field_name: "node_id",
				field_schema: "keyword",
			});
		}
	}

	async deleteFileVectors(path: string): Promise<void> {
		console.log(`[Qdrant] Suppression des vecteurs pour ${path}...`);
		await this.client.delete(this.collection, {
			filter: {
				should: this.pathVariants(path).map((value) => ({
					key: "path",
					match: { value },
				})),
			},
			wait: true,
		});
	}

	async hasCurrentContentHash(path: string, contentHash: string): Promise<boolean> {
		const { points } = await this.client.scroll(this.collection, {
			filter: {
				should: this.pathVariants(path).map((value) => ({
					key: "path",
					match: { value },
				})),
			},
			limit: 1,
			with_payload: ["content_hash"],
			with_vector: false,
		});
		return points[0]?.payload?.content_hash === contentHash;
	}

	async indexChunks(
		path: string,
		nodeId: string,
		chunks: Chunk[],
		contentHash: string,
		metadata: OcisFileMetadata = { webdav_url: "" },
		source = "ownCloud",
	): Promise<number> {
		if (chunks.length === 0) return 0;

		// Generate all embeddings before changing the current index. A provider
		// failure must not make an already indexed document disappear.
		const texts = chunks.map((c) => c.text);
		console.log(`[Qdrant] Calcul de ${texts.length} embeddings pour ${path}...`);
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
			id: this.pointId(path, chunk.chunkIndex),
			vector: vectors[idx]!,
			payload: {
				path,
				node_id: nodeId,
				filename: path.split("/").pop() || "",
				chunk_index: chunk.chunkIndex,
				content_hash: contentHash,
				source,
				...metadata,
				text: chunk.text,
				indexed_at: new Date().toISOString(),
			},
		}));

		await this.client.upsert(this.collection, {
			wait: true,
			points,
		});
		await this.client.delete(this.collection, {
			filter: {
				should: this.pathVariants(path).map((value) => ({
					key: "path",
					match: { value },
				})),
				must_not: [{ has_id: points.map((point) => point.id) }],
			},
			wait: true,
		});

		console.log(`[Qdrant] ${points.length} chunks indexés avec succès pour ${path}`);
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

	private pointId(path: string, chunkIndex: number): string {
		// Qdrant accepts UUID point IDs. Hashing keeps chunk IDs stable between
		// retries while avoiding collisions between files.
		const hash = new Bun.CryptoHasher("sha256").update(`${path}\0${chunkIndex}`).digest();
		const bytes = new Uint8Array(16);
		for (let i = 0; i < bytes.length; i++) bytes[i] = hash[i]!;
		bytes[6] = (bytes[6]! & 0x0f) | 0x50;
		bytes[8] = (bytes[8]! & 0x3f) | 0x80;
		const hex = Buffer.from(bytes).toString("hex");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}

	async search(query: string, limit = 5, pathPrefix?: string) {
		const [queryVector] = await this.embedder.embed([query]);
		if (!queryVector) {
			throw new Error("Impossible de générer l'embedding pour la requête");
		}

		const filter: Record<string, unknown> = {};
		if (pathPrefix) {
			filter.must = [
				{
					key: "path",
					match: { text: pathPrefix },
				},
			];
		}

		const { points } = await this.client.query(this.collection, {
			query: queryVector,
			limit: Math.max(1, Math.min(Math.trunc(limit), 100)),
			filter: Object.keys(filter).length > 0 ? filter : undefined,
			with_payload: true,
		});

		return points.map((r) => ({
			score: r.score,
			path: r.payload?.path as string,
			filename: r.payload?.filename as string,
			text: r.payload?.text as string,
			chunkIndex: r.payload?.chunk_index as number,
			webdavUrl: r.payload?.webdav_url as string,
			lastModified: r.payload?.last_modified as string | undefined,
			createdAt: r.payload?.created_at as string | undefined,
			sizeBytes: r.payload?.size_bytes as number | undefined,
			contentType: r.payload?.content_type as string | undefined,
			etag: r.payload?.etag as string | undefined,
			source: (r.payload?.source as string | undefined) || "unknown",
		}));
	}
}
