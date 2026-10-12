export interface Config {
	natsUrl: string;
	qdrantUrl: string;
	qdrantApiKey?: string;
	qdrantCollection: string;
	ocisWebdavUrl: string;
	ocisUsername: string;
	ocisPassword?: string;
	ocisToken?: string;
	ocisRequestTimeoutMs: number;
	ocisMaxFileSizeBytes: number;
	tikaUrl?: string;
	embeddingProvider: "cloudflare" | "openai" | "ollama";
	embeddingMaxTokens: number;
	cloudflareAccountId?: string;
	cloudflareApiToken?: string;
	cloudflareModel: string;
	openaiApiKey?: string;
	openaiModel: string;
	openaiBaseUrl: string;
	ollamaBaseUrl: string;
	ollamaModel: string;
	mcpPort: number;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} doit être un entier positif.`);
	}
	return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const provider = env.EMBEDDING_PROVIDER || "cloudflare";
	if (!["cloudflare", "openai", "ollama"].includes(provider)) {
		throw new Error(
			`EMBEDDING_PROVIDER invalide (« ${provider} »). Valeurs acceptées : cloudflare, openai, ollama.`,
		);
	}

	const mcpPort = positiveInteger(env.MCP_PORT, 3000, "MCP_PORT");
	if (mcpPort > 65535) throw new Error("MCP_PORT doit être compris entre 1 et 65535.");
	const embeddingMaxTokens = positiveInteger(
		env.EMBEDDING_MAX_TOKENS,
		7_000,
		"EMBEDDING_MAX_TOKENS",
	);
	if (embeddingMaxTokens < 4) {
		throw new Error("EMBEDDING_MAX_TOKENS doit être au moins égal à 4.");
	}

	return {
		natsUrl: env.NATS_URL || "nats://owncloud:9233",
		qdrantUrl: env.QDRANT_URL || "http://qdrant:6333",
		qdrantApiKey: env.QDRANT_API_KEY,
		qdrantCollection: env.QDRANT_COLLECTION || "owncloud_documents",
		ocisWebdavUrl: env.OCIS_WEBDAV_URL || "http://owncloud:9200/remote.php/dav/files",
		ocisUsername: env.OCIS_USERNAME || "admin",
		ocisPassword: env.OCIS_PASSWORD,
		ocisToken: env.OCIS_TOKEN,
		ocisRequestTimeoutMs: positiveInteger(
			env.OCIS_REQUEST_TIMEOUT_MS,
			30_000,
			"OCIS_REQUEST_TIMEOUT_MS",
		),
		ocisMaxFileSizeBytes: positiveInteger(
			env.OCIS_MAX_FILE_SIZE_BYTES,
			50 * 1024 * 1024,
			"OCIS_MAX_FILE_SIZE_BYTES",
		),
		tikaUrl: env.TIKA_URL?.replace(/\/+$/, "") || undefined,
		embeddingProvider: provider as Config["embeddingProvider"],
		embeddingMaxTokens,
		cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID,
		cloudflareApiToken: env.CLOUDFLARE_API_TOKEN,
		cloudflareModel: env.CLOUDFLARE_MODEL || "@cf/baai/bge-m3",
		openaiApiKey: env.OPENAI_API_KEY,
		openaiModel: env.OPENAI_MODEL || "text-embedding-3-small",
		openaiBaseUrl: env.OPENAI_BASE_URL || "https://api.openai.com/v1",
		ollamaBaseUrl: env.OLLAMA_BASE_URL || "http://host.docker.internal:11434",
		ollamaModel: env.OLLAMA_MODEL || "bge-m3",
		mcpPort,
	};
}

export const config = loadConfig();
