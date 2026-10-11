import { describe, expect, it, mock } from "bun:test";
import { NatsConsumer } from "./nats.ts";
import type { OcisClient } from "./ocis.ts";
import type { QdrantManager } from "./qdrant.ts";

describe("NatsConsumer", () => {
	it("propagates indexing errors so the message can be retried", async () => {
		const ocis = {
			downloadFile: mock(async () => Buffer.from("content")),
		} as unknown as OcisClient;
		const qdrant = {
			indexChunks: mock(async () => {
				throw new Error("temporary Qdrant failure");
			}),
		} as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis);

		await expect(
			consumer.handleEvent("storage.events.UploadReady", {
				FileRef: { Path: "document.md" },
			}),
		).rejects.toThrow("temporary Qdrant failure");
		expect(ocis.downloadFile).toHaveBeenCalledWith("document.md");
	});

	it("ignores events without a file path", async () => {
		const ocis = { downloadFile: mock(async () => Buffer.from("")) } as unknown as OcisClient;
		const qdrant = { indexChunks: mock(async () => 0) } as unknown as QdrantManager;
		const consumer = new NatsConsumer(qdrant, ocis);

		await expect(consumer.handleEvent("storage.events.UploadReady", {})).resolves.toBeUndefined();
		expect(ocis.downloadFile).not.toHaveBeenCalled();
	});
});
