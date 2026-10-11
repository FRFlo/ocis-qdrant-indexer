export interface Config {
	natsUrl: string;
	qdrantUrl: string;
	qdrantApiKey?: string;
	qdrantCollection: string;
	ocisWebdavUrl: string;
	ocisUsername: string;
	ocisPassword?: string;
	ocisToken?: string;
	embeddingProvider: "cloudflare" | "openai" | "ollama";
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

export const config: Config = {
	natsUrl: process.env.NATS_URL || "nats://owncloud:9233",
	qdrantUrl: process.env.QDRANT_URL || "http://qdrant:6333",
	qdrantApiKey: process.env.QDRANT_API_KEY,
	qdrantCollection: process.env.QDRANT_COLLECTION || "owncloud_documents",
	ocisWebdavUrl: process.env.OCIS_WEBDAV_URL || "http://owncloud:9200/remote.php/dav/files",
	ocisUsername: process.env.OCIS_USERNAME || "admin",
	ocisPassword: process.env.OCIS_PASSWORD,
	ocisToken: process.env.OCIS_TOKEN,
	embeddingProvider:
		(process.env.EMBEDDING_PROVIDER as "cloudflare" | "openai" | "ollama") || "cloudflare",
	cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
	cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN,
	cloudflareModel: process.env.CLOUDFLARE_MODEL || "@cf/baai/bge-m3",
	openaiApiKey: process.env.OPENAI_API_KEY,
	openaiModel: process.env.OPENAI_MODEL || "text-embedding-3-small",
	openaiBaseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
	ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434",
	ollamaModel: process.env.OLLAMA_MODEL || "bge-m3",
	mcpPort: Number.parseInt(process.env.MCP_PORT || "3000", 10),
};
