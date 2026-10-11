import { connect, type NatsConnection } from "nats";
import { config } from "./config.ts";
import type { OcisClient } from "./ocis.ts";
import { chunkText, extractText } from "./parser.ts";
import type { QdrantManager } from "./qdrant.ts";

export interface OcisEvent {
	FileRef?: {
		Path?: string;
		ResourceId?: {
			SpaceId?: string;
			OpaqueId?: string;
		};
	};
	ResourceID?: {
		SpaceId?: string;
		OpaqueId?: string;
	};
	Timestamp?: string;
	[key: string]: unknown;
}

export class NatsConsumer {
	private nc?: NatsConnection;
	private qdrant: QdrantManager;
	private ocis: OcisClient;

	constructor(qdrant: QdrantManager, ocis: OcisClient) {
		this.qdrant = qdrant;
		this.ocis = ocis;
	}

	async start(): Promise<void> {
		console.log(`[NATS] Connexion au bus oCIS sur ${config.natsUrl}...`);
		try {
			this.nc = await connect({ servers: config.natsUrl });
			console.log("[NATS] Connecté avec succès !");

			const js = this.nc.jetstream();

			// Souscription aux événements JetStream de stockage
			// Sujets oCIS standards émis par le service storage-users
			const sub = await js.subscribe("*.events.*", {
				durable: "ocis-qdrant-indexer",
			});

			(async () => {
				for await (const m of sub) {
					try {
						const eventName = m.subject;
						const rawData = m.data.toString();
						const data: OcisEvent = JSON.parse(rawData);

						console.log(`[NATS] Événement reçu [${eventName}]`);
						await this.handleEvent(eventName, data);
						m.ack();
					} catch (err) {
						console.error("[NATS] Erreur traitement événement:", err);
						m.nak();
					}
				}
			})();
		} catch (err) {
			console.error("[NATS] Erreur connexion au bus:", err);
			// Ne bloque pas le démarrage de l'app si NATS n'est pas encore prêt, retente en arrière-plan
			setTimeout(() => this.start(), 5000);
		}
	}

	async handleEvent(eventName: string, data: OcisEvent): Promise<void> {
		const path = data.FileRef?.Path;
		const nodeId = data.ResourceID?.OpaqueId || data.FileRef?.ResourceId?.OpaqueId || "unknown";

		if (!path) return;

		// 1. Upload ou modification de fichier
		if (
			eventName.includes("UploadReady") ||
			eventName.includes("upload") ||
			eventName.includes("postprocessing")
		) {
			console.log(`[Indexer] Indexation demandée pour ${path} (ID: ${nodeId})`);
			try {
				const buffer = await this.ocis.downloadFile(path);
				const filename = path.split("/").pop() || "";
				const parsed = await extractText(filename, buffer);

				if (!parsed.text.trim()) {
					console.log(`[Indexer] Aucun texte extractible pour ${path}, ignoré.`);
					return;
				}

				const chunks = chunkText(parsed.text);
				await this.qdrant.indexChunks(path, nodeId, chunks);
			} catch (err) {
				console.error(`[Indexer] Échec de l'indexation de ${path}:`, err);
			}
		}

		// 2. Suppression de fichier (corbeille ou purge définitive)
		if (
			eventName.includes("ItemTrashed") ||
			eventName.includes("ItemPurged") ||
			eventName.includes("delete")
		) {
			console.log(`[Indexer] Fichier supprimé dans oCIS, purge des vecteurs: ${path}`);
			try {
				await this.qdrant.deleteFileVectors(path);
			} catch (err) {
				console.error(`[Indexer] Échec de la purge de ${path}:`, err);
			}
		}
	}

	async close(): Promise<void> {
		if (this.nc) {
			await this.nc.close();
		}
	}
}
