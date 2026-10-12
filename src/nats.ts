import {
	AckPolicy,
	connect,
	DeliverPolicy,
	type ConsumerMessages,
	type NatsConnection,
} from "nats";
import { createHash } from "node:crypto";
import { config } from "./config.ts";
import type { OcisClient } from "./ocis.ts";
import { chunkText, extractText } from "./parser.ts";
import type { QdrantManager } from "./qdrant.ts";
import { getEmbeddingTokenCounter, type TokenCounter } from "./tokenizer.ts";

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

function normalizeFilePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment && segment !== ".")
		.join("/");
}

export class NatsConsumer {
	private nc?: NatsConnection;
	private messages?: ConsumerMessages;
	private qdrant: QdrantManager;
	private ocis: OcisClient;
	private tokenCounterFactory: () => Promise<TokenCounter>;
	private initialScanStarted = false;
	private indexingByPath = new Map<string, Promise<void>>();

	constructor(
		qdrant: QdrantManager,
		ocis: OcisClient,
		tokenCounterFactory: () => Promise<TokenCounter> = getEmbeddingTokenCounter,
	) {
		this.qdrant = qdrant;
		this.ocis = ocis;
		this.tokenCounterFactory = tokenCounterFactory;
	}

	async start(): Promise<void> {
		console.log(`[NATS] Connexion au bus oCIS sur ${config.natsUrl}...`);
		if (!this.initialScanStarted) {
			this.initialScanStarted = true;
			void this.indexExistingFiles();
		}
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
		const rawPath = fileRef?.Path ?? fileRef?.path;
		const path = rawPath ? normalizeFilePath(rawPath) : "";
		const resourceId = data.ResourceID ?? data.ID ?? data.id;
		const fileResourceId = fileRef?.ResourceId ?? fileRef?.resource_id;
		const nodeId =
			resourceId?.OpaqueId ??
			resourceId?.opaque_id ??
			fileResourceId?.OpaqueId ??
			fileResourceId?.opaque_id ??
			"unknown";
		const spaceId =
			resourceId?.SpaceId ??
			resourceId?.space_id ??
			fileResourceId?.SpaceId ??
			fileResourceId?.space_id;
		const publicResourceId = spaceId && nodeId !== "unknown" ? `${spaceId}$${nodeId}` : undefined;

		if (!path) return;

		if (eventName === "events.UploadReady" || eventName === "events.FileUploaded") {
			if (eventName === "events.UploadReady" && data.Failed) {
				console.log(`[Indexer] Upload oCIS échoué pour ${path}, ignoré.`);
				return;
			}
			try {
				await this.indexFile(path, nodeId, publicResourceId);
			} catch (err) {
				console.error(`[Indexer] Échec de l'indexation de ${path}:`, err);
				throw err;
			}
		}

		// 2. Suppression de fichier (corbeille ou purge définitive)
		if (eventName === "events.ItemTrashed" || eventName === "events.ItemPurged") {
			try {
				await this.qdrant.deleteFileVectors(path);
				console.log(`[Indexer] supprimé: ${path}`);
			} catch (err) {
				console.error(`[Indexer] Échec de la purge de ${path}:`, err);
				throw err;
			}
		}
	}

	private async indexExistingFiles(): Promise<void> {
		try {
			let files: string[] | undefined;
			for (let attempt = 1; attempt <= 5; attempt++) {
				try {
					files = await this.ocis.listFiles();
					break;
				} catch (err) {
					const isConnectionError =
						err instanceof Error &&
						/ECONNREFUSED|ECONNRESET|ETIMEDOUT|Unable to connect|fetch failed/i.test(
							`${err.name}: ${err.message}`,
						);
					if (!isConnectionError || attempt === 5) throw err;

					const delayMs = 1_000 * 2 ** (attempt - 1);
					console.warn(
						`[Indexer] WebDAV indisponible, nouvel essai du scan dans ${delayMs} ms (${attempt}/5).`,
					);
					await new Promise((resolve) => setTimeout(resolve, delayMs));
				}
			}
			if (!files) throw new Error("Le scan WebDAV n'a retourné aucun résultat.");
			const livePaths = new Set(files.map(normalizeFilePath));
			let checked = 0,
				updated = 0,
				deleted = 0,
				added = 0;
			let cursor = 0;
			const workers = Array.from(
				{ length: Math.min(config.indexConcurrency, files.length) },
				async () => {
					while (cursor < files.length) {
						const path = files[cursor++]!;
						try {
							const result = await this.indexFile(path, "unknown");
							checked++;
							if (result === "updated") updated++;
							if (result === "added") added++;
						} catch (err) {
							console.error(`[Indexer] Échec du scan de ${path}:`, err);
						}
					}
				},
			);
			await Promise.all(workers);
			const indexedPaths = this.qdrant.listIndexedPaths ? await this.qdrant.listIndexedPaths() : [];
			for (const path of indexedPaths) {
				if (!livePaths.has(normalizeFilePath(path))) {
					await this.qdrant.deleteFileVectors(path);
					deleted++;
					console.log(`[Indexer] supprimé: ${path}`);
				}
			}
			console.log(
				`[Indexer] Bilan: ${checked} checkés, ${updated} update, ${deleted} supprimés, ${added} ajoutés.`,
			);
		} catch (err) {
			console.error("[Indexer] Échec du scan initial WebDAV:", err);
		}
	}

	private async indexFile(
		path: string,
		nodeId: string,
		publicResourceId?: string,
	): Promise<"unchanged" | "updated" | "added"> {
		const previous = this.indexingByPath.get(path) ?? Promise.resolve();
		const current = previous
			.catch(() => undefined)
			.then(() => this.indexFileIfChanged(path, nodeId, publicResourceId));
		this.indexingByPath.set(path, current);

		try {
			return await current;
		} finally {
			if (this.indexingByPath.get(path) === current) {
				this.indexingByPath.delete(path);
			}
		}
	}

	private async indexFileIfChanged(
		path: string,
		nodeId: string,
		publicResourceId?: string,
	): Promise<"unchanged" | "updated" | "added"> {
		const metadata = await this.ocis.getFileMetadata(path);
		if (config.ocisPublicUrl && publicResourceId) {
			const encodedId = encodeURIComponent(publicResourceId)
				.replace(/%24/gi, "$")
				.replace(/!/g, "%21");
			metadata.ocis_url = `${config.ocisPublicUrl}/f/${encodedId}`;
		}
		const buffer = await this.ocis.downloadFile(path);
		const contentHash = createHash("sha256").update(buffer).digest("hex");
		if (await this.qdrant.hasCurrentContentHash(path, contentHash)) {
			return "unchanged";
		}
		const existed = this.qdrant.hasIndexedPath ? await this.qdrant.hasIndexedPath(path) : false;

		const filename = path.split("/").pop() || "";
		const parsed = await extractText(filename, buffer);
		if (!parsed.text.trim()) {
			await this.qdrant.deleteFileVectors(path);
			console.log(`[Indexer] supprimé: ${path}`);
			return "updated";
		}

		const countTokens = await this.tokenCounterFactory();
		const chunks = chunkText(parsed.text, countTokens, config.embeddingMaxTokens);
		await this.qdrant.indexChunks(path, nodeId, chunks, contentHash, metadata, "ownCloud");
		console.log(`[Indexer] indexé: ${path}`);
		return existed ? "updated" : "added";
	}

	async close(): Promise<void> {
		await this.messages?.close();
		if (this.nc) {
			await this.nc.close();
		}
	}
}
