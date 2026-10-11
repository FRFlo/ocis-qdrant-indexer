import {
	AckPolicy,
	connect,
	DeliverPolicy,
	type ConsumerMessages,
	type NatsConnection,
} from "nats";
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
	private messages?: ConsumerMessages;
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
			const jsm = await js.jetstreamManager();
			const stream = await jsm.streams.find("*.events.*");
			const durable = "ocis-qdrant-indexer";

			try {
				await jsm.consumers.info(stream, durable);
			} catch {
				await jsm.consumers.add(stream, {
					durable_name: durable,
					filter_subject: "*.events.*",
					deliver_policy: DeliverPolicy.All,
					ack_policy: AckPolicy.Explicit,
					ack_wait: 30_000_000_000,
					max_deliver: 10,
				});
			}
			const consumer = await js.consumers.get(stream, durable);
			this.messages = await consumer.consume();

			(async () => {
				for await (const m of this.messages!) {
					try {
						const eventName = m.subject;
						const rawData = m.data.toString();
						const data: OcisEvent = JSON.parse(rawData);

						console.log(`[NATS] Événement reçu [${eventName}]`);
						await this.handleEvent(eventName, data);
						m.ack();
					} catch (err) {
						console.error("[NATS] Erreur traitement événement:", err);
						// Delay the retry to avoid a hot loop on persistent failures.
						m.nak(5000);
					}
				}
			})();
		} catch (err) {
			console.error("[NATS] Erreur connexion au bus:", err);
			// Retry connection or subscription failures without retaining a broken
			// connection or recursively creating timers.
			await this.nc?.close().catch(() => undefined);
			this.nc = undefined;
			setTimeout(() => void this.start(), 5000);
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
				throw err;
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
				throw err;
			}
		}
	}

	async close(): Promise<void> {
		await this.messages?.close();
		if (this.nc) {
			await this.nc.close();
		}
	}
}
