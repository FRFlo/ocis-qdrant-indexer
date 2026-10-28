import {
	AckPolicy,
	connect,
	DeliverPolicy,
	type ConsumerMessages,
	type NatsConnection,
} from "nats";
import { config } from "./config.ts";
import type { UserIndexer } from "./user-indexer.ts";

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

export function decodeOcisBusMessage(rawMessage: Uint8Array): {
	eventName: string;
	data: OcisEvent;
} {
	const busMessage: OcisBusMessage = JSON.parse(Buffer.from(rawMessage).toString("utf8"));
	if (busMessage.Payload === undefined) {
		throw new Error("Message oCIS invalide : payload manquant.");
	}
	let payload: unknown;
	if (typeof busMessage.Payload === "string") {
		try {
			payload = JSON.parse(busMessage.Payload);
		} catch {
			payload = JSON.parse(Buffer.from(busMessage.Payload, "base64").toString("utf8"));
		}
	} else {
		payload = JSON.parse(Buffer.from(busMessage.Payload).toString("utf8"));
	}

	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new Error("Message oCIS invalide : payload JSON inattendu.");
	}
	const envelope = payload as { Type?: unknown; Event?: unknown };
	const event =
		envelope.Event && typeof envelope.Event === "object" && !Array.isArray(envelope.Event)
			? (envelope.Event as OcisEvent)
			: (payload as OcisEvent);
	const eventName =
		busMessage.Metadata?.[EVENT_TYPE_METADATA] ??
		(typeof envelope.Type === "string" ? envelope.Type : undefined) ??
		(typeof event.Type === "string" ? event.Type : undefined);
	if (!eventName) {
		throw new Error("Message oCIS invalide : eventtype manquant.");
	}
	return { eventName, data: event };
}

export class NatsConsumer {
	private nc?: NatsConnection;
	private messages?: ConsumerMessages;
	private userIndexer: UserIndexer;
	private initialScanStarted = false;

	constructor(userIndexer: UserIndexer) {
		this.userIndexer = userIndexer;
	}

	async start(): Promise<void> {
		// NATS_URL may contain credentials; never write it to application logs.
		console.log("[NATS] Connexion au bus oCIS...");
		this.startInitialReconciliation();
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
			console.log(`[NATS] Abonné au stream ${stream}, sujet ${OCIS_SUBJECT}.`);

			(async () => {
				for await (const m of this.messages!) {
					try {
						const { eventName, data } = decodeOcisBusMessage(m.data);
						console.info(`[NATS] Événement reçu: ${eventName}.`);
						await this.handleEvent(eventName, data);
						m.ack();
						console.info(`[NATS] Événement traité: ${eventName}.`);
					} catch (err) {
						console.error("[NATS] Erreur traitement événement:", err);
						m.nak(5000);
					}
				}
			})();
		} catch (err) {
			console.error("[NATS] Erreur connexion au bus:", err);
			await this.nc?.close().catch(() => undefined);
			this.nc = undefined;
			setTimeout(() => void this.start(), 5000);
		}
	}

	private startInitialReconciliation(): void {
		if (this.initialScanStarted) return;
		this.initialScanStarted = true;
		void this.userIndexer.syncRegisteredUsers();
	}

	async handleEvent(eventName: string, data: OcisEvent): Promise<void> {
		await this.userIndexer.handleEvent(eventName, data);
	}

	async close(): Promise<void> {
		await this.messages?.close();
		if (this.nc) await this.nc.close();
	}
}
