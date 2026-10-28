import { createHash } from "node:crypto";
import { OcisClient } from "./ocis.ts";
import { config } from "./config.ts";
import type { BasicCredentials } from "./auth.ts";
import type { OcisUserContext } from "./ocis.ts";
import { chunkText, extractText } from "./parser.ts";
import type { QdrantManager, QdrantTenantScope } from "./qdrant.ts";
import { getEmbeddingTokenCounter, type TokenCounter } from "./tokenizer.ts";
import { userScopeId } from "./auth.ts";
import type { StoredUserCredentials, UserCredentialStore } from "./user-store.ts";

export interface UserSyncResult {
	userId: string;
	spaces: number;
	checked: number;
	indexed: number;
	deleted: number;
}

type OcisClientFactory = (credentials: BasicCredentials) => OcisClient;

export class UserIndexer {
	private qdrant: QdrantManager;
	private store: UserCredentialStore;
	private syncsInFlight = new Map<string, Promise<UserSyncResult>>();
	private clientFactory: OcisClientFactory;
	private tokenCounterFactory: () => Promise<TokenCounter>;
	private tokenCounterPromise?: Promise<TokenCounter>;

	constructor(
		qdrant: QdrantManager,
		store: UserCredentialStore,
		clientFactory: OcisClientFactory = (credentials) => new OcisClient(credentials),
		tokenCounterFactory: () => Promise<TokenCounter> = getEmbeddingTokenCounter,
	) {
		this.qdrant = qdrant;
		this.store = store;
		this.clientFactory = clientFactory;
		this.tokenCounterFactory = tokenCounterFactory;
	}

	async authenticate(credentials: BasicCredentials): Promise<OcisUserContext> {
		const client = this.clientFactory(credentials);
		const context = await client.getUserContext();
		if (context.username !== credentials.username || !context.userId) {
			throw new Error("Les identifiants ownCloud ne correspondent pas à une identité vérifiée.");
		}

		const previous = this.store.get(context.userId);
		const tenantId = userScopeId(context.userId);
		const currentDriveIds = new Set(context.drives.map((drive) => drive.id));
		for (const oldDrive of previous?.drives ?? []) {
			if (!currentDriveIds.has(oldDrive.id)) {
				await this.qdrant.deleteSpaceVectors(tenantId, oldDrive.id);
			}
		}

		this.store.save({
			userId: context.userId,
			username: context.username,
			pat: credentials.pat,
			drives: context.drives,
		});
		if (!previous) this.startInitialSync(context, credentials);
		return context;
	}

	async search(credentials: BasicCredentials, query: string, limit = 5, pathPrefix?: string) {
		const context = await this.authenticate(credentials);
		await this.qdrant.ensureCollection(userScopeId(context.userId));
		return this.qdrant.search(query, limit, pathPrefix, {
			tenantId: userScopeId(context.userId),
			spaceIds: context.drives.map((drive) => drive.id),
		});
	}

	async sync(credentials: BasicCredentials): Promise<UserSyncResult> {
		const context = await this.authenticate(credentials);
		const pending = this.syncsInFlight.get(context.userId);
		if (pending) return pending;

		const sync = this.syncContext(credentials, context);
		this.syncsInFlight.set(context.userId, sync);
		try {
			return await sync;
		} finally {
			if (this.syncsInFlight.get(context.userId) === sync) {
				this.syncsInFlight.delete(context.userId);
			}
		}
	}

	private async syncContext(
		credentials: BasicCredentials,
		context: OcisUserContext,
	): Promise<UserSyncResult> {
		const tenantId = userScopeId(context.userId);
		await this.qdrant.ensureCollection(tenantId);
		let checked = 0;
		let indexed = 0;
		let deleted = 0;
		const client = this.clientFactory(credentials);

		for (const drive of context.drives) {
			const driveClient = client.forDrive(drive.id);
			const files = await driveClient.listFiles();
			const livePaths = new Set(files);
			for (const path of files) {
				const result = await this.indexFile(
					driveClient,
					path,
					{ tenantId, spaceId: drive.id },
					context.userId,
				);
				checked++;
				if (result === "indexed") indexed++;
			}
			const indexedPaths = await this.qdrant.listIndexedPaths({
				tenantId,
				spaceId: drive.id,
			});
			for (const path of indexedPaths) {
				if (!livePaths.has(path)) {
					await this.qdrant.deleteFileVectors(path, { tenantId, spaceId: drive.id });
					deleted++;
				}
			}
		}
		return { userId: context.userId, spaces: context.drives.length, checked, indexed, deleted };
	}

	private startInitialSync(context: OcisUserContext, credentials: BasicCredentials): void {
		if (this.syncsInFlight.has(context.userId)) return;
		const tenantId = userScopeId(context.userId);
		console.info(
			`[Indexer] Première authentification enregistrée (tenant=${tenantId}); sync initiale démarrée.`,
		);
		const sync = Promise.resolve().then(() => this.syncContext(credentials, context));
		this.syncsInFlight.set(context.userId, sync);
		void sync
			.then((result) => {
				console.info(
					`[Indexer] Sync initiale terminée (tenant=${tenantId}, espaces=${result.spaces}, ` +
						`vérifiés=${result.checked}, indexés=${result.indexed}, supprimés=${result.deleted}).`,
				);
			})
			.catch((error: unknown) => {
				const errorType = error instanceof Error ? error.name : "Erreur inconnue";
				console.error(
					`[Indexer] Échec de la sync initiale (tenant=${tenantId}, type=${errorType}).`,
				);
			})
			.finally(() => {
				if (this.syncsInFlight.get(context.userId) === sync) {
					this.syncsInFlight.delete(context.userId);
				}
			});
	}

	async syncRegisteredUsers(): Promise<void> {
		let users: StoredUserCredentials[];
		try {
			users = this.store.list();
		} catch (error) {
			console.error("[Indexer] Impossible de lire le registre des utilisateurs:", error);
			return;
		}
		console.info(`[Indexer] Réconciliation des utilisateurs enregistrés: ${users.length}.`);
		for (const user of users) {
			try {
				const result = await this.sync({ username: user.username, pat: user.pat });
				console.info(
					`[Indexer] Réconciliation terminée (tenant=${userScopeId(user.userId)}, ` +
						`espaces=${result.spaces}, vérifiés=${result.checked}, indexés=${result.indexed}, ` +
						`supprimés=${result.deleted}).`,
				);
			} catch (error) {
				const errorType = error instanceof Error ? error.name : "Erreur inconnue";
				console.error(
					`[Indexer] Échec de réconciliation (tenant=${userScopeId(user.userId)}, type=${errorType}).`,
				);
			}
		}
	}

	async handleEvent(
		eventName: string,
		data: {
			Ref?: {
				Path?: string;
				path?: string;
				ResourceId?: {
					SpaceId?: string;
					space_id?: string;
					OpaqueId?: string;
					opaque_id?: string;
				};
				resource_id?: {
					SpaceId?: string;
					space_id?: string;
					OpaqueId?: string;
					opaque_id?: string;
				};
			};
			FileRef?: {
				Path?: string;
				path?: string;
				ResourceId?: {
					SpaceId?: string;
					space_id?: string;
					OpaqueId?: string;
					opaque_id?: string;
				};
				resource_id?: {
					SpaceId?: string;
					space_id?: string;
					OpaqueId?: string;
					opaque_id?: string;
				};
			};
			ResourceID?: { SpaceId?: string; space_id?: string; OpaqueId?: string; opaque_id?: string };
			ID?: { SpaceId?: string; space_id?: string; OpaqueId?: string; opaque_id?: string };
			id?: { SpaceId?: string; space_id?: string; OpaqueId?: string; opaque_id?: string };
			Failed?: boolean;
		},
	): Promise<void> {
		const isUpload = eventName === "events.UploadReady" || eventName === "events.FileUploaded";
		const isDelete = eventName === "events.ItemTrashed" || eventName === "events.ItemPurged";
		if (!isUpload && !isDelete) return;
		if (eventName === "events.UploadReady" && data.Failed) return;

		const fileRef = data.FileRef ?? data.Ref;
		const path = (fileRef?.Path ?? fileRef?.path ?? "")
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment && segment !== ".")
			.join("/");
		const resourceId = data.ResourceID ?? data.ID ?? data.id;
		const spaceId =
			resourceId?.SpaceId ??
			resourceId?.space_id ??
			fileRef?.ResourceId?.SpaceId ??
			fileRef?.ResourceId?.space_id ??
			fileRef?.resource_id?.SpaceId ??
			fileRef?.resource_id?.space_id;
		if (!spaceId || !path) {
			// A path alone is not a safe tenant key: several users/spaces may
			// contain the same relative path.
			console.info(`[Indexer] ${eventName} sans espace/chemin; réconciliation sécurisée.`);
			await this.syncRegisteredUsers();
			return;
		}

		const users = this.store.list();
		const authorizedUsers = users.filter((user) =>
			user.drives.some((drive) => drive.id === spaceId),
		);
		if (authorizedUsers.length === 0) {
			console.info(
				`[Indexer] ${eventName} pour un espace non enregistré; réconciliation sécurisée.`,
			);
			await this.syncRegisteredUsers();
			return;
		}

		for (const user of authorizedUsers) {
			if (!user.drives.some((drive) => drive.id === spaceId)) continue;
			const client = this.clientFactory({ username: user.username, pat: user.pat });
			const context = await client.getUserContext();
			if (context.userId !== user.userId) continue;
			const accessibleDrive = context.drives.find((drive) => drive.id === spaceId);
			if (!accessibleDrive) {
				await this.qdrant.deleteSpaceVectors(userScopeId(user.userId), spaceId);
				this.store.save({ ...user, drives: context.drives });
				continue;
			}

			const tenantId = userScopeId(user.userId);
			const scope = { tenantId, spaceId };
			if (isDelete) {
				await this.qdrant.deleteFileVectors(path, scope);
				console.info(`[Indexer] ${eventName} traité (suppression, tenant=${tenantId}).`);
				continue;
			}
			const result = await this.indexFile(client.forDrive(spaceId), path, scope, user.userId);
			console.info(`[Indexer] ${eventName} traité (${result}, tenant=${tenantId}).`);
		}
	}

	private async indexFile(
		client: OcisClient,
		path: string,
		scope: QdrantTenantScope,
		userId: string,
	): Promise<"unchanged" | "indexed"> {
		const metadata = await client.getFileMetadata(path);
		const buffer = await client.downloadFile(path);
		const contentHash = createHash("sha256").update(buffer).digest("hex");
		if (await this.qdrant.hasCurrentContentHash(path, contentHash, scope)) {
			await this.qdrant.updateFileMetadata(path, metadata, scope);
			return "unchanged";
		}

		const filename = path.split("/").pop() || "";
		const parsed = await extractText(filename, buffer);
		if (!parsed.text.trim()) return "unchanged";
		const countTokens = await (this.tokenCounterPromise ??= this.tokenCounterFactory());
		const chunks = chunkText(parsed.text, countTokens, config.embeddingMaxTokens);
		const resourceId = metadata.ocis_url?.match(/\/f\/([^/]+)/)?.[1];
		await this.qdrant.indexChunks(
			path,
			resourceId || userId,
			chunks,
			contentHash,
			scope,
			metadata,
			"ownCloud",
		);
		return "indexed";
	}
}
