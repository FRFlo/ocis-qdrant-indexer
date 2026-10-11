import { config } from "./config.ts";

export class OcisClient {
	private baseUrl: string;
	private authHeader: string;

	constructor() {
		this.baseUrl = config.ocisWebdavUrl;
		if (config.ocisToken) {
			this.authHeader = `Bearer ${config.ocisToken}`;
		} else if (config.ocisUsername && config.ocisPassword) {
			const creds = Buffer.from(`${config.ocisUsername}:${config.ocisPassword}`).toString("base64");
			this.authHeader = `Basic ${creds}`;
		} else {
			this.authHeader = "";
		}
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

			const res = await fetch(directoryUrl, {
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
				throw new Error(
					`Échec de l'énumération WebDAV (${res.status} ${res.statusText}) pour ${directoryUrl}`,
				);
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

		console.log(`[oCIS] Téléchargement du fichier ${path}...`);
		const res = await fetch(url, {
			headers: this.authHeaders(),
			signal: AbortSignal.timeout(config.ocisRequestTimeoutMs),
		});
		if (!res.ok) {
			throw new Error(
				`Échec du téléchargement WebDAV (${res.status} ${res.statusText}) pour ${path}`,
			);
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

	private fileUrl(path: string): string {
		const baseUrl = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
		const segments = [config.ocisUsername, ...path.split("/").filter(Boolean)];
		const encodedPath = segments.map(encodeURIComponent).join("/");
		return new URL(path ? encodedPath : `${encodedPath}/`, baseUrl).toString();
	}

	private authHeaders(): Record<string, string> {
		return this.authHeader ? { Authorization: this.authHeader } : {};
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
