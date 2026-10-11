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
	Ref?: {
		Path?: string;
		path?: string;
		ResourceId?: OcisResourceId;
		resource_id?: OcisResourceId;
	};
	FileRef?: {
		Path?: string;
		path?: string;
		ResourceId?: OcisResourceId;
		resource_id?: OcisResourceId;
	};
	ResourceID?: OcisResourceId;
	ID?: OcisResourceId;
	id?: OcisResourceId;
	Failed?: boolean;
	Timestamp?: string;
	[key: string]: unknown;
}

interface OcisResourceId {
	SpaceId?: string;
	OpaqueId?: string;
	space_id?: string;
	opaque_id?: string;
}

interface OcisBusMessage {
	Metadata?: Record<string, string>;
	Payload?: string | number[];
}

const OCIS_STREAM = "main-queue";
const OCIS_SUBJECT = "main-queue";
const EVENT_TYPE_METADATA = "eventtype";

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
			const eventSubject = OCIS_SUBJECT;
			let stream: string;
			try {
				stream = await jsm.streams.find(eventSubject);
			} catch (err) {
				const available: string[] = [];
				for await (const info of jsm.streams.list()) {
					available.push(`${info.config.name} [${info.config.subjects.join(", ")}]`);
				}
				const details = available.length
					? `Streams présents : ${available.join("; ")}.`
					: "Aucun stream JetStream n'est configuré.";
				throw new Error(
					`Aucun stream JetStream ne correspond au sujet ${eventSubject}. ${details} ` +
						`oCIS publie ses événements sur ${OCIS_STREAM}. Vérifiez que le stream existe et capture ce sujet.`,
					{ cause: err },
				);
			}
			const durable = "ocis-qdrant-indexer";

			try {
				await jsm.consumers.info(stream, durable);
			} catch {
				await jsm.consumers.add(stream, {
					durable_name: durable,
					filter_subject: OCIS_SUBJECT,
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
						const busMessage: OcisBusMessage = JSON.parse(m.data.toString());
						const eventName = busMessage.Metadata?.[EVENT_TYPE_METADATA];
						if (!eventName || busMessage.Payload === undefined) {
							throw new Error("Message oCIS invalide : eventtype ou payload manquant.");
						}
						const rawData =
							typeof busMessage.Payload === "string"
								? Buffer.from(busMessage.Payload, "base64").toString("utf8")
								: Buffer.from(busMessage.Payload).toString("utf8");
						const data: OcisEvent = JSON.parse(rawData);

						console.log(`[NATS] Événement reçu [${eventName}] sur ${m.subject}`);
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
		const fileRef = data.FileRef ?? data.Ref;
		const path = fileRef?.Path ?? fileRef?.path;
		const resourceId = data.ResourceID ?? data.ID ?? data.id;
		const fileResourceId = fileRef?.ResourceId ?? fileRef?.resource_id;
		const nodeId =
			resourceId?.OpaqueId ??
			resourceId?.opaque_id ??
			fileResourceId?.OpaqueId ??
			fileResourceId?.opaque_id ??
			"unknown";

		if (!path) return;

		if (eventName === "events.UploadReady" || eventName === "events.FileUploaded") {
			if (eventName === "events.UploadReady" && data.Failed) {
				console.log(`[Indexer] Upload oCIS échoué pour ${path}, ignoré.`);
				return;
			}
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
		if (eventName === "events.ItemTrashed" || eventName === "events.ItemPurged") {
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
