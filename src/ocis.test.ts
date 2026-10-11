import { afterEach, describe, expect, it, mock } from "bun:test";
import { OcisClient } from "./ocis.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("OcisClient", () => {
	it("encodes path segments and downloads files", async () => {
		const fetchMock = mock(
			async (_input: string | URL, _init?: RequestInit) => new Response("document"),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = new OcisClient();

		const result = await client.downloadFile("/folder/my file.md");

		expect(result.toString()).toBe("document");
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://owncloud:9200/remote.php/dav/files/admin/folder/my%20file.md",
		);
	});

	it("recursively lists WebDAV files and skips collection entries", async () => {
		const directoryListing = `<?xml version="1.0"?>
			<d:multistatus xmlns:d="DAV:">
				<d:response><d:href>/remote.php/dav/files/admin/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
				<d:response><d:href>/remote.php/dav/files/admin/Cours/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
			</d:multistatus>`;
		const fileListing = `<?xml version="1.0"?>
			<d:multistatus xmlns:d="DAV:">
				<d:response><d:href>/remote.php/dav/files/admin/Cours/notes%20de%20cours.md</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>
			</d:multistatus>`;
		const fetchMock = mock(
			async (input: string | URL, _init?: RequestInit) =>
				new Response(String(input).endsWith("/Cours/") ? fileListing : directoryListing),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = new OcisClient();

		await expect(client.listFiles()).resolves.toEqual(["Cours/notes de cours.md"]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PROPFIND" });
	});

	it("rejects traversal and files exceeding the configured limit", async () => {
		const fetchMock = mock(
			async (_input: string | URL) =>
				new Response("too large", { headers: { "content-length": String(60 * 1024 * 1024) } }),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = new OcisClient();

		await expect(client.downloadFile("../secrets")).rejects.toThrow(
			"Chemin de fichier WebDAV invalide",
		);
		await expect(client.downloadFile("large.bin")).rejects.toThrow("Fichier trop volumineux");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
