import { describe, expect, it, mock } from "bun:test";
import { config } from "./config.ts";
import { decodeOcisBusMessage, NatsConsumer } from "./nats.ts";
import type { OcisClient } from "./ocis.ts";
import type { QdrantManager } from "./qdrant.ts";

const testTokenCounterFactory = async () => (text: string) => Array.from(text).length;

describe("NatsConsumer", () => {
	it("décode les octets NATS UTF-8 avant d'analyser l'enveloppe JSON", () => {
		const event = { FileRef: { path: "document.pdf" } };
		const envelope = {
			Metadata: { eventtype: "events.FileUploaded" },
			Payload: Buffer.from(JSON.stringify(event)).toString("base64"),
		};
		const rawMessage = new Uint8Array(Buffer.from(JSON.stringify(envelope), "utf8"));

		expect(decodeOcisBusMessage(rawMessage)).toEqual({
			eventName: "events.FileUploaded",
			data: event,
		});
	});

	it("retries the initial WebDAV scan after a connection refusal", async () => {
		let attempts = 0;
		const ocis = {
			listFiles: mock(async () => {
				attempts++;
				if (attempts === 1) throw new Error("ECONNREFUSED");
				return [];
			}),
		} as unknown as OcisClient;
		const consumer = new NatsConsumer({} as QdrantManager, ocis, testTokenCounterFactory);

		await (consumer as unknown as { indexExistingFiles: () => Promise<void> }).indexExistingFiles();

		expect(ocis.listFiles).toHaveBeenCalledTimes(2);
	});

	it("deletes indexed documents missing from ownCloud during the initial scan", async () => {
		const ocis = { listFiles: mock(async () => []) } as unknown as OcisClient;
		const qdrant = {
			listIndexedPaths: mock(async () => ["removed/document.md"]),
			deleteFileVectors: mock(async () => undefined),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		await (consumer as unknown as { indexExistingFiles: () => Promise<void> }).indexExistingFiles();

		expect(qdrant.deleteFileVectors).toHaveBeenCalledWith("removed/document.md");
	});

	it("indexes official oCIS UploadReady payloads and propagates failures", async () => {
		const ocis = {
			getFileMetadata: mock(async () => ({ webdav_url: "https://owncloud/document.md" })),
			downloadFile: mock(async () => Buffer.from("content")),
		} as unknown as OcisClient;
		const qdrant = {
			hasCurrentContentHash: mock(async () => false),
			indexChunks: mock(async () => {
				throw new Error("temporary Qdrant failure");
			}),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		await expect(
			consumer.handleEvent("events.UploadReady", {
				FileRef: { path: "document.md", resource_id: { opaque_id: "node-1" } },
			}),
		).rejects.toThrow("temporary Qdrant failure");
		expect(ocis.downloadFile).toHaveBeenCalledWith("document.md");
	});

	it("purges vectors for official oCIS trash events", async () => {
		const ocis = { downloadFile: mock(async () => Buffer.from("")) } as unknown as OcisClient;
		const qdrant = {
			deleteFileVectors: mock(async () => undefined),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		await consumer.handleEvent("events.ItemTrashed", {
			Ref: { path: "/personal/document.md" },
			ID: { opaque_id: "node-1" },
		});

		expect(qdrant.deleteFileVectors).toHaveBeenCalledWith("personal/document.md");
	});

	it("indexes synchronous FileUploaded events from Ref.path", async () => {
		const ocis = {
			getFileMetadata: mock(async () => ({ webdav_url: "https://owncloud/document.md" })),
			downloadFile: mock(async () => Buffer.from("plain text")),
		} as unknown as OcisClient;
		const qdrant = {
			hasCurrentContentHash: mock(async () => false),
			indexChunks: mock(async () => 1),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		await consumer.handleEvent("events.FileUploaded", {
			Ref: { path: "/personal/document.md" },
		});

		expect(ocis.downloadFile).toHaveBeenCalledWith("personal/document.md");
		expect(qdrant.indexChunks).toHaveBeenCalled();
	});

	it("stores an oCIS /f/ link using the full space and resource IDs", async () => {
		const originalPublicUrl = config.ocisPublicUrl;
		config.ocisPublicUrl = "https://owncloud.example";
		const ocis = {
			getFileMetadata: mock(async () => ({ webdav_url: "https://dav/document.md" })),
			downloadFile: mock(async () => Buffer.from("plain text")),
		} as unknown as OcisClient;
		const qdrant = {
			hasCurrentContentHash: mock(async () => false),
			indexChunks: mock(async () => 1),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		try {
			await consumer.handleEvent("events.FileUploaded", {
				Ref: { path: "document.md" },
				ResourceID: {
					SpaceId: "2acaad56-f816-4061-a5dd-5e4fb29f8f51",
					OpaqueId: "5c6829a8-0925-4b97-9d00-f5533fc91dff!63661b17-d67a-4899-8c53-3ced7da4a6fc",
				},
			});

			const metadata = (qdrant.indexChunks as ReturnType<typeof mock>).mock.calls[0]?.[4];
			expect(metadata).toMatchObject({
				ocis_url:
					"https://owncloud.example/f/2acaad56-f816-4061-a5dd-5e4fb29f8f51$5c6829a8-0925-4b97-9d00-f5533fc91dff%2163661b17-d67a-4899-8c53-3ced7da4a6fc",
			});
		} finally {
			config.ocisPublicUrl = originalPublicUrl;
		}
	});

	it("skips embedding generation when a file hash is already indexed", async () => {
		const ocis = {
			getFileMetadata: mock(async () => ({ webdav_url: "https://owncloud/document.md" })),
			downloadFile: mock(async () => Buffer.from("unchanged")),
		} as unknown as OcisClient;
		const qdrant = {
			hasCurrentContentHash: mock(async () => true),
			indexChunks: mock(async () => 0),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		await consumer.handleEvent("events.UploadReady", {
			FileRef: { path: "document.md" },
		});

		expect(ocis.downloadFile).toHaveBeenCalledWith("document.md");
		expect(qdrant.indexChunks).not.toHaveBeenCalled();
	});

	it("ignores failed UploadReady events", async () => {
		const ocis = { downloadFile: mock(async () => Buffer.from("")) } as unknown as OcisClient;
		const qdrant = { indexChunks: mock(async () => 0) } as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		await consumer.handleEvent("events.UploadReady", {
			FileRef: { path: "/personal/document.md" },
			Failed: true,
		});

		expect(ocis.downloadFile).not.toHaveBeenCalled();
	});

	it("does not index binary Office uploads when Tika is unavailable", async () => {
		const originalTikaUrl = config.tikaUrl;
		config.tikaUrl = undefined;
		const ocis = {
			getFileMetadata: mock(async () => ({ webdav_url: "https://owncloud/report.docx" })),
			downloadFile: mock(async () => Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])),
		} as unknown as OcisClient;
		const qdrant = {
			hasCurrentContentHash: mock(async () => false),
			indexChunks: mock(async () => 0),
			deleteFileVectors: mock(async () => undefined),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		try {
			await consumer.handleEvent("events.FileUploaded", {
				Ref: { path: "report.docx" },
			});
			expect(ocis.downloadFile).toHaveBeenCalledWith("report.docx");
			expect(qdrant.indexChunks).not.toHaveBeenCalled();
		} finally {
			config.tikaUrl = originalTikaUrl;
		}
	});

	it("preserves existing vectors when extraction returns no text", async () => {
		const originalTikaUrl = config.tikaUrl;
		config.tikaUrl = undefined;
		const ocis = {
			getFileMetadata: mock(async () => ({ webdav_url: "https://owncloud/report.docx" })),
			downloadFile: mock(async () => Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])),
		} as unknown as OcisClient;
		const qdrant = {
			hasCurrentContentHash: mock(async () => false),
			hasIndexedPath: mock(async () => true),
			indexChunks: mock(async () => 0),
			deleteFileVectors: mock(async () => undefined),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		try {
			await consumer.handleEvent("events.FileUploaded", {
				Ref: { path: "report.docx" },
			});
			expect(qdrant.deleteFileVectors).not.toHaveBeenCalled();
			expect(qdrant.indexChunks).not.toHaveBeenCalled();
		} finally {
			config.tikaUrl = originalTikaUrl;
		}
	});

	it("ignores events without a file reference path", async () => {
		const ocis = { downloadFile: mock(async () => Buffer.from("")) } as unknown as OcisClient;
		const qdrant = {
			indexChunks: mock(async () => 0),
			deleteFileVectors: mock(async () => undefined),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis, testTokenCounterFactory);

		await expect(consumer.handleEvent("events.UploadReady", {})).resolves.toBeUndefined();
		expect(ocis.downloadFile).not.toHaveBeenCalled();
	});
});
