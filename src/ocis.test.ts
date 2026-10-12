import { afterEach, describe, expect, it, mock } from "bun:test";
import { config } from "./config.ts";
import { OcisClient } from "./ocis.ts";

const originalFetch = globalThis.fetch;
const originalToken = config.ocisToken;
const originalWebdavUrl = config.ocisWebdavUrl;

config.ocisPassword = "test-password";

afterEach(() => {
	globalThis.fetch = originalFetch;
	config.ocisPassword = "test-password";
	config.ocisToken = originalToken;
	config.ocisWebdavUrl = originalWebdavUrl;
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

	it("uses a configured oCIS space URL as the root without appending the username", async () => {
		const spaceUrl =
			"https://owncloud.example.org/dav/spaces/2acaad56-f816-4061-a5dd-5e4fb29f8f51$5c6829a8-0925-4b97-9d00-f5533fc91dff/";
		config.ocisWebdavUrl = spaceUrl;
		const fetchMock = mock(
			async (_input: string | URL, _init?: RequestInit) => new Response("document"),
		);
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = new OcisClient();

		await client.downloadFile("folder/document.txt");

		expect(fetchMock.mock.calls[0]?.[0]).toBe(`${spaceUrl}folder/document.txt`);
	});

	it("retries an OIDC/app token as Basic after Bearer is rejected", async () => {
		config.ocisWebdavUrl = "https://owncloud.example.org/dav/spaces/test-space/";
		config.ocisPassword = undefined;
		config.ocisToken = "app-token";
		const fetchMock = mock(async (_input: string | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			if (fetchMock.mock.calls.length === 1) {
				expect(headers.get("authorization")).toBe("Bearer app-token");
				return new Response(null, { status: 401, statusText: "Unauthorized" });
			}
			expect(headers.get("authorization")).toBe(
				`Basic ${Buffer.from(`${config.ocisUsername}:app-token`).toString("base64")}`,
			);
			return new Response("document");
		});
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = new OcisClient();

		await expect(client.downloadFile("document.txt")).resolves.toEqual(Buffer.from("document"));
		expect(fetchMock).toHaveBeenCalledTimes(2);
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

	it("reads file metadata from WebDAV properties", async () => {
		config.ocisWebdavUrl = "https://owncloud.example/dav/spaces/test-space/";
		globalThis.fetch = mock(
			async () =>
				new Response(`<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>
				<d:getlastmodified>Wed, 01 Jan 2025 12:00:00 GMT</d:getlastmodified>
				<d:creationdate>2025-01-01T10:00:00Z</d:creationdate>
				<d:getcontentlength>42</d:getcontentlength>
				<d:getcontenttype>text/markdown</d:getcontenttype>
				<d:getetag>"etag-1"</d:getetag>
			</d:prop></d:propstat></d:response></d:multistatus>`),
		) as unknown as typeof fetch;
		const client = new OcisClient();

		await expect(client.getFileMetadata("notes/page.md")).resolves.toMatchObject({
			webdav_url: "https://owncloud.example/dav/spaces/test-space/notes/page.md",
			last_modified: "Wed, 01 Jan 2025 12:00:00 GMT",
			created_at: "2025-01-01T10:00:00Z",
			size_bytes: 42,
			content_type: "text/markdown",
			etag: '"etag-1"',
		});
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
