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
		// Nettoie le path relatif
		const cleanPath = path.startsWith("./")
			? path.slice(2)
			: path.startsWith("/")
				? path.slice(1)
				: path;

		// URL WebDAV oCIS
		const url = `${this.baseUrl}/${config.ocisUsername}/${cleanPath}`;

		const headers: Record<string, string> = {};
		if (this.authHeader) {
			headers.Authorization = this.authHeader;
		}

		console.log(`[oCIS] Téléchargement de ${url}...`);
		const res = await fetch(url, { headers });
		if (!res.ok) {
			throw new Error(
				`Échec du téléchargement WebDAV (${res.status} ${res.statusText}) pour ${path}`,
			);
		}

		const arrayBuffer = await res.arrayBuffer();
		return Buffer.from(arrayBuffer);
	}
}
