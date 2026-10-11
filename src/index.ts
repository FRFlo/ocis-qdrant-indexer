import { createEmbedder } from "./embedder.ts";
import { createMcpServer } from "./mcp.ts";
import { NatsConsumer } from "./nats.ts";
import { OcisClient } from "./ocis.ts";
import { QdrantManager } from "./qdrant.ts";

console.log("=== Démarrage de ocis-qdrant-indexer ===");

// 1. Initialise l'embedder (Cloudflare, OpenAI, ou Ollama)
const embedder = createEmbedder();

// 2. Initialise Qdrant et s'assure que la collection existe
const qdrant = new QdrantManager(embedder);
await qdrant.ensureCollection();

// 3. Client oCIS WebDAV
const ocis = new OcisClient();

// 4. Démarre le serveur MCP Streamable HTTP
createMcpServer(qdrant);

// 5. Démarre le consommateur NATS en arrière-plan
const natsConsumer = new NatsConsumer(qdrant, ocis);
await natsConsumer.start();

console.log("=== Service opérationnel et prêt ===");
