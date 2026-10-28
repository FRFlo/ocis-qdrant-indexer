import { config } from "./config.ts";

export interface OcisFileMetadata {
	webdav_url: string;
	ocis_url?: string;
	last_modified?: string;
	created_at?: string;
	size_bytes?: number;
	content_type?: string;
	etag?: string;
}

export interface OcisDrive {
	id: string;
	name: string;
	driveType?: string;
}

export interface OcisUserContext {
	userId: string;
	username: string;
	drives: OcisDrive[];
}

export class OcisApiError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "OcisApiError";
		this.status = status;
	}
}

export class OcisClient {
	private baseUrl: string;
	private authHeader: string;
	private username: string;
	private graphBaseUrl: string;
	private pat: string;

	constructor(credentials: { username: string; pat: string; webdavUrl?: string }) {
		this.baseUrl = credentials.webdavUrl ?? config.ocisWebdavUrl;
		this.username = credentials.username;
		this.pat = credentials.pat;
		this.graphBaseUrl = config.ocisGraphUrl;
		const encodedCredentials = Buffer.from(`${credentials.username}:${credentials.pat}`).toString(
			"base64",
		);
		this.authHeader = `Basic ${encodedCredentials}`;
	}

	async getUserContext(): Promise<OcisUserContext> {
		const user = (await this.fetchGraph(`${this.graphBaseUrl}/me`)) as { id?: unknown };
		if (typeof user.id !== "string" || !user.id) {
			throw new Error("La réponse Graph ownCloud ne contient pas l'identifiant de l'utilisateur.");
		}

		const driveRecords: Array<{ id?: unknown; name?: unknown; driveType?: unknown }> = [];
		const base = new URL(this.graphBaseUrl);
		let nextUrl: string | undefined = `${this.graphBaseUrl}/me/drives`;
		while (nextUrl) {
			const pageUrl = new URL(nextUrl, this.graphBaseUrl);
			if (
				pageUrl.origin !== base.origin ||
				!pageUrl.pathname.startsWith(`${base.pathname.replace(/\/+$/, "")}/`)
			) {
				throw new Error("La pagination Graph ownCloud pointe vers une URL inattendue.");
			}
			const page = (await this.fetchGraph(pageUrl.toString())) as {
				value?: Array<{ id?: unknown; name?: unknown; driveType?: unknown }>;
				"@odata.nextLink"?: unknown;
			};
			if (!Array.isArray(page.value)) {
				throw new Error("La réponse Graph ownCloud ne contient pas de liste d'espaces.");
			}
			driveRecords.push(...page.value);
			nextUrl = typeof page["@odata.nextLink"] === "string" ? page["@odata.nextLink"] : undefined;
		}

		return {
			userId: user.id,
			username: this.username,
			drives: driveRecords.flatMap((drive) =>
				typeof drive.id === "string" && drive.id
					? [
							{
								id: drive.id,
								name: typeof drive.name === "string" ? drive.name : drive.id,
								driveType: typeof drive.driveType === "string" ? drive.driveType : undefined,
							},
						]
					: [],
			),
		};
	}

	private async fetchGraph(url: string): Promise<unknown> {
		const response = await fetch(url, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(config.ocisRequestTimeoutMs),
		});
		if (!response.ok) {
			throw new OcisApiError(
				`Échec de la requête Graph ownCloud (${response.status} ${response.statusText}).`,
				response.status,
			);
		}
		return response.json();
	}

	forDrive(driveId: string): OcisClient {
		const root = `${new URL(this.baseUrl).origin}/dav/spaces/${encodeURIComponent(driveId)}/`;
		return new OcisClient({
			username: this.username,
			pat: this.pat,
			webdavUrl: root,
		});
	}

	async listFiles(): Promise<string[]> {
		const root = this.fileUrl("");
		const rootPath = new URL(root).pathname;
		const pending = [root];
		const visited = new Set<string>();
		const files: string[] = [];
		const body =
			'<?xml version="1.0" encoding="utf-8" ?>' +
			'<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';

		while (pending.length > 0) {
			const directoryUrl = pending.pop()!;
			if (visited.has(directoryUrl)) continue;
			visited.add(directoryUrl);

			const res = await this.fetchWebdav(directoryUrl, {
				method: "PROPFIND",
				headers: {
					...this.authHeaders(),
					Depth: "1",
					"Content-Type": "application/xml; charset=utf-8",
				},
				body,
				signal: AbortSignal.timeout(config.ocisRequestTimeoutMs),
			});
			if (!res.ok) {
				throw new Error(this.webdavError("l'énumération", res, directoryUrl));
			}

			const xml = await res.text();
			for (const response of xml.matchAll(
				/<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response\s*>/gi,
			)) {
				const block = response[1] || "";
				const href = this.xmlTag(block, "href");
				if (!href) continue;

				const url = new URL(this.decodeXml(href), directoryUrl);
				if (url.origin !== new URL(root).origin || !url.pathname.startsWith(rootPath)) continue;
				const relativePath = url.pathname.slice(rootPath.length).replace(/\/+$/, "");
				if (!relativePath) continue;

				const segments = relativePath.split("/").map((segment) => {
					try {
						return decodeURIComponent(segment);
					} catch {
						throw new Error(`Chemin WebDAV invalide reçu dans PROPFIND: ${href}`);
					}
				});
				if (
					segments.some(
						(segment) =>
							!segment ||
							segment === "." ||
							segment === ".." ||
							segment.includes("/") ||
							segment.includes("\\") ||
							[...segment].some((char) => char.charCodeAt(0) < 32),
					)
				) {
					continue;
				}
				const path = segments.join("/");
				const resourceType = this.xmlTag(block, "resourcetype") || "";
				if (/<(?:[\w.-]+:)?collection(?:\s[^>]*)?\s*\/?>/i.test(resourceType)) {
					pending.push(url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`);
				} else {
					files.push(path);
				}
			}
		}

		return files;
	}

	async downloadFile(path: string): Promise<Buffer> {
		const segments = path
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment && segment !== ".");
		if (
			segments.length === 0 ||
			segments.some(
				(segment) =>
					segment === ".." ||
					segment.includes("/") ||
					segment.includes("\\") ||
					[...segment].some((char) => char.charCodeAt(0) < 32),
			)
		) {
			throw new Error("Chemin de fichier WebDAV invalide.");
		}

		const url = this.fileUrl(segments.join("/"));

		let res: Response;
		for (let attempt = 0; ; attempt++) {
			res = await this.fetchWebdav(url, {
				headers: this.authHeaders(),
				signal: AbortSignal.timeout(config.ocisRequestTimeoutMs),
			});
			if (res.status !== 425 || attempt >= 2) break;
			await res.body?.cancel();
			await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
		}
		if (!res.ok) {
			throw new Error(this.webdavError("du téléchargement", res, path));
		}

		const contentLength = Number(res.headers.get("content-length"));
		if (Number.isFinite(contentLength) && contentLength > config.ocisMaxFileSizeBytes) {
			throw new Error(
				`Fichier trop volumineux (${contentLength} octets, limite ${config.ocisMaxFileSizeBytes}).`,
			);
		}
		if (!res.body) return Buffer.alloc(0);
		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				totalBytes += value.byteLength;
				if (totalBytes > config.ocisMaxFileSizeBytes) {
					await reader.cancel();
					throw new Error(
						`Fichier trop volumineux (limite ${config.ocisMaxFileSizeBytes} octets).`,
					);
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(
			chunks.map((chunk) => Buffer.from(chunk)),
			totalBytes,
		);
	}

	async getFileMetadata(path: string): Promise<OcisFileMetadata> {
		const url = this.fileUrl(path);
		const body =
			'<?xml version="1.0" encoding="utf-8" ?>' +
			'<d:propfind xmlns:d="DAV:"><d:prop><d:getlastmodified/><d:creationdate/><d:getcontentlength/><d:getcontenttype/><d:getetag/></d:prop></d:propfind>';
		const res = await this.fetchWebdav(url, {
			method: "PROPFIND",
			headers: {
				...this.authHeaders(),
				Depth: "0",
				"Content-Type": "application/xml; charset=utf-8",
			},
			body,
			signal: AbortSignal.timeout(config.ocisRequestTimeoutMs),
		});
		if (!res.ok) {
			throw new Error(this.webdavError("de la lecture des métadonnées", res, path));
		}
		const xml = await res.text();
		const contentLength = Number(this.xmlTag(xml, "getcontentlength"));
		return {
			webdav_url: url,
			last_modified: this.decodeXml(this.xmlTag(xml, "getlastmodified") || "") || undefined,
			created_at: this.decodeXml(this.xmlTag(xml, "creationdate") || "") || undefined,
			size_bytes: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : undefined,
			content_type: this.decodeXml(this.xmlTag(xml, "getcontenttype") || "") || undefined,
			etag: this.decodeXml(this.xmlTag(xml, "getetag") || "") || undefined,
		};
	}

	private fileUrl(path: string): string {
		const baseUrl = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
		const isLegacyFilesEndpoint = /\/(?:remote\.php\/)?dav\/files\/?$/i.test(
			new URL(baseUrl).pathname,
		);
		const segments = [
			...(isLegacyFilesEndpoint ? [this.username] : []),
			...path.split("/").filter(Boolean),
		];
		const encodedPath = segments.map(encodeURIComponent).join("/");
		return new URL(path ? encodedPath : encodedPath ? `${encodedPath}/` : "", baseUrl).toString();
	}

	private authHeaders(): Record<string, string> {
		return this.authHeader ? { Authorization: this.authHeader } : {};
	}

	private async fetchWebdav(url: string, init: RequestInit): Promise<Response> {
		return fetch(url, init);
	}

	private webdavError(operation: string, res: Response, resource: string): string {
		const hint = res.status === 401 ? " Vérifiez le nom d'utilisateur ownCloud et son PAT." : "";
		return `Échec ${operation} WebDAV (${res.status} ${res.statusText}) pour ${resource}.${hint}`;
	}

	private xmlTag(xml: string, tag: string): string | undefined {
		const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = xml.match(
			new RegExp(
				`<(?:[\\w.-]+:)?${escaped}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${escaped}\\s*>`,
				"i",
			),
		);
		return match?.[1]?.trim();
	}

	private decodeXml(value: string): string {
		return value
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&apos;/g, "'");
	}
}
