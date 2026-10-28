import { createEmbedder } from "./embedder.ts";
import { createMcpServer } from "./mcp.ts";
import { NatsConsumer } from "./nats.ts";
import { QdrantManager } from "./qdrant.ts";
import { config } from "./config.ts";
import { UserCredentialStore } from "./user-store.ts";
import { UserIndexer } from "./user-indexer.ts";

console.log("=== Démarrage de ocis-qdrant-indexer ===");

// 1. Initialise l'embedder (Cloudflare, OpenAI, ou Ollama)
const embedder = createEmbedder();

// 2. Initialise Qdrant; les collections isolées sont créées par utilisateur.
const qdrant = new QdrantManager(embedder);

// 3. Registre durable; le PAT est chiffré avec la clé de déploiement.
const userStore = new UserCredentialStore(config.userStorePath, config.userStoreEncryptionKey);
const userIndexer = new UserIndexer(qdrant, userStore);

// 4. Démarre le serveur MCP Streamable HTTP
createMcpServer(qdrant, userIndexer);

// 5. Démarre le consommateur NATS en arrière-plan
const natsConsumer = new NatsConsumer(userIndexer);
await natsConsumer.start();

console.log("=== Service opérationnel et prêt ===");
