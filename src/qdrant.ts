import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "./config.ts";
import type { Embedder } from "./embedder.ts";
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
				must: [
					{
						key: "path",
						match: { value: path },
					},
				],
			},
		});
	}

	async indexChunks(path: string, nodeId: string, chunks: Chunk[]): Promise<number> {
		if (chunks.length === 0) return 0;

		// 1. Supprime d'abord les anciens vecteurs du fichier
		await this.deleteFileVectors(path);

		// 2. Calcule les embeddings par batch
		const texts = chunks.map((c) => c.text);
		console.log(`[Qdrant] Calcul de ${texts.length} embeddings pour ${path}...`);
		const vectors = await this.embedder.embed(texts);

		// 3. Insère les nouveaux points
		const points = chunks.map((chunk, idx) => ({
			id: crypto.randomUUID(),
			vector: vectors[idx] ?? [],
			payload: {
				path,
				node_id: nodeId,
				filename: path.split("/").pop() || "",
				chunk_index: chunk.chunkIndex,
				text: chunk.text,
				indexed_at: new Date().toISOString(),
			},
		}));

		await this.client.upsert(this.collection, {
			wait: true,
			points,
		});

		console.log(`[Qdrant] ${points.length} chunks indexés avec succès pour ${path}`);
		return points.length;
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

		const results = await this.client.search(this.collection, {
			vector: queryVector,
			limit,
			filter: Object.keys(filter).length > 0 ? filter : undefined,
			with_payload: true,
		});

		return results.map((r) => ({
			score: r.score,
			path: r.payload?.path as string,
			filename: r.payload?.filename as string,
			text: r.payload?.text as string,
			chunkIndex: r.payload?.chunk_index as number,
		}));
	}
}
