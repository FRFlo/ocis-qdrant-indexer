import { afterEach, describe, expect, it, mock } from "bun:test";
import { OcisClient } from "./ocis.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("OcisClient", () => {
	it("encodes path segments and downloads files", async () => {
		const fetchMock = mock(async (_input: string | URL) => new Response("document"));
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		const client = new OcisClient();

		const result = await client.downloadFile("/folder/my file.md");

		expect(result.toString()).toBe("document");
		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			"http://owncloud:9200/remote.php/dav/files/admin/folder/my%20file.md",
		);
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
