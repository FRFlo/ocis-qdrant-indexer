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

	async downloadFile(path: string): Promise<Buffer> {
		let segments: string[];
		try {
			segments = path
				.replace(/\\/g, "/")
				.split("/")
				.filter((segment) => segment && segment !== ".")
				.map((segment) => decodeURIComponent(segment));
		} catch {
			throw new Error("Chemin de fichier WebDAV invalide.");
		}
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

		const baseUrl = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
		const encodedPath = [config.ocisUsername, ...segments].map(encodeURIComponent).join("/");
		const url = new URL(encodedPath, baseUrl).toString();

		const headers: Record<string, string> = {};
		if (this.authHeader) {
			headers.Authorization = this.authHeader;
		}

		console.log(`[oCIS] Téléchargement du fichier ${path}...`);
		const res = await fetch(url, {
			headers,
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
}
