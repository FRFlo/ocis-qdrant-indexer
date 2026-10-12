import { config } from "./config.ts";

export interface Embedder {
	embed(texts: string[]): Promise<number[][]>;
	dimensions(): number;
}

export class CloudflareEmbedder implements Embedder {
	private accountId: string;
	private apiToken: string;
	private model: string;

	constructor(accountId?: string, apiToken?: string, model?: string) {
		this.accountId = accountId || config.cloudflareAccountId || "";
		this.apiToken = apiToken || config.cloudflareApiToken || "";
		this.model = model || config.cloudflareModel;

		if (!this.accountId || !this.apiToken) {
			throw new Error(
				"EMBEDDING_PROVIDER=cloudflare requiert CLOUDFLARE_ACCOUNT_ID et CLOUDFLARE_API_TOKEN.",
			);
		}
	}

	dimensions(): number {
		return 1024; // bge-m3 output dimension
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];

		const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`;
		const vectors: number[][] = [];
		let batch: string[] = [];
		let batchChars = 0;
		const flush = async () => {
			if (batch.length === 0) return;
			const res = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ text: batch }),
			});
			if (!res.ok) {
				const err = await res.text();
				throw new Error(`Erreur Cloudflare Workers AI (${res.status}): ${err}`);
			}
			const data = (await res.json()) as { result?: { data?: number[][] } };
			if (!data.result?.data || data.result.data.length !== batch.length) {
				throw new Error("Réponse Cloudflare invalide : embeddings manquants");
			}
			vectors.push(...data.result.data);
			batch = [];
			batchChars = 0;
		};

		// Keep total request size safely below the model's context window.
		for (const text of texts) {
			if (batch.length && (batch.length >= 16 || batchChars + text.length > 20_000)) {
				await flush();
			}
			batch.push(text);
			batchChars += text.length;
		}
		await flush();
		return vectors;
	}
}

export class OpenAIEmbedder implements Embedder {
	private apiKey: string;
	private model: string;
	private baseUrl: string;

	constructor(apiKey?: string, model?: string, baseUrl?: string) {
		this.apiKey = apiKey || config.openaiApiKey || "";
		this.model = model || config.openaiModel;
		this.baseUrl = baseUrl || config.openaiBaseUrl;
		if (!this.apiKey) {
			throw new Error("EMBEDDING_PROVIDER=openai requiert OPENAI_API_KEY.");
		}
	}

	dimensions(): number {
		return 1536; // text-embedding-3-small dimension
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];

		const url = `${this.baseUrl}/embeddings`;
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				input: texts,
				model: this.model,
			}),
		});

		if (!res.ok) {
			const err = await res.text();
			throw new Error(`Erreur OpenAI Embeddings (${res.status}): ${err}`);
		}

		const data = (await res.json()) as {
			data?: Array<{ embedding: number[]; index: number }>;
		};

		if (!data.data) {
			throw new Error("Réponse OpenAI invalide");
		}

		return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
	}
}

export class OllamaEmbedder implements Embedder {
	private baseUrl: string;
	private model: string;

	constructor(baseUrl?: string, model?: string) {
		this.baseUrl = baseUrl || config.ollamaBaseUrl;
		this.model = model || config.ollamaModel;
	}

	dimensions(): number {
		return 1024;
	}

	async embed(texts: string[]): Promise<number[][]> {
		const results: number[][] = [];
		for (const text of texts) {
			const res = await fetch(`${this.baseUrl}/api/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					prompt: text,
				}),
			});

			if (!res.ok) {
				const err = await res.text();
				throw new Error(`Erreur Ollama (${res.status}): ${err}`);
			}

			const data = (await res.json()) as { embedding: number[] };
			results.push(data.embedding);
		}
		return results;
	}
}

export function createEmbedder(): Embedder {
	switch (config.embeddingProvider) {
		case "cloudflare":
			return new CloudflareEmbedder();
		case "openai":
			return new OpenAIEmbedder();
		case "ollama":
			return new OllamaEmbedder();
		default:
			throw new Error(`Provider d'embedding inconnu: ${config.embeddingProvider}`);
	}
}
