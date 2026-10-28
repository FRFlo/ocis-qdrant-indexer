import { describe, expect, it, mock } from "bun:test";
import { decodeOcisBusMessage, NatsConsumer } from "./nats.ts";
import type { UserIndexer } from "./user-indexer.ts";

function mockUserIndexer() {
	return {
		handleEvent: mock(async () => undefined),
		syncRegisteredUsers: mock(async () => undefined),
	} as unknown as UserIndexer;
}

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

	it("décode les événements oCIS enveloppés dans le champ Event", () => {
		const event = {
			FileRef: {
				path: "./Notes/plan.md",
				resource_id: { space_id: "alice-drive", opaque_id: "file-1" },
			},
		};
		const envelope = {
			Metadata: { eventtype: "events.UploadReady" },
			Payload: Buffer.from(JSON.stringify({ Type: "events.UploadReady", Event: event })).toString(
				"base64",
			),
		};

		expect(decodeOcisBusMessage(Buffer.from(JSON.stringify(envelope)))).toEqual({
			eventName: "events.UploadReady",
			data: event,
		});
	});

	it("accepts an unencoded JSON payload and its event type", () => {
		const event = { FileRef: { path: "Notes/plan.md" } };
		const envelope = {
			Payload: JSON.stringify({ Type: "events.FileUploaded", Event: event }),
		};

		expect(decodeOcisBusMessage(Buffer.from(JSON.stringify(envelope)))).toEqual({
			eventName: "events.FileUploaded",
			data: event,
		});
	});

	it("reconciles previously registered users at process startup exactly once", async () => {
		const userIndexer = mockUserIndexer();
		const consumer = new NatsConsumer(userIndexer);
		const startInitialReconciliation = (
			consumer as unknown as { startInitialReconciliation: () => void }
		).startInitialReconciliation;

		startInitialReconciliation.call(consumer);
		startInitialReconciliation.call(consumer);
		await Promise.resolve();

		expect(userIndexer.syncRegisteredUsers).toHaveBeenCalledTimes(1);
	});

	it("delegates every event to the multi-user router", async () => {
		const userIndexer = mockUserIndexer();
		const consumer = new NatsConsumer(userIndexer);
		const event = { Ref: { path: "Notes/plan.md" }, ResourceID: { SpaceId: "alice-drive" } };

		await consumer.handleEvent("events.FileUploaded", event);

		expect(userIndexer.handleEvent).toHaveBeenCalledWith("events.FileUploaded", event);
	});
});
