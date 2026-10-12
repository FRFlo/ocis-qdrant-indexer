import { describe, expect, it, mock } from "bun:test";
import { config } from "./config.ts";
import { NatsConsumer } from "./nats.ts";
import type { OcisClient } from "./ocis.ts";
import type { QdrantManager } from "./qdrant.ts";

const testTokenCounterFactory = async () => (text: string) => Array.from(text).length;

describe("NatsConsumer", () => {
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
