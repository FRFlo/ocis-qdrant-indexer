import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isMcpSessionOwnedBy, registerSyncTool } from "./mcp.ts";
import type { BasicCredentials } from "./auth.ts";

describe("MCP session ownership", () => {
	it("accepts requests from the identity that created the session", () => {
		expect(isMcpSessionOwnedBy("alice-owncloud-id", "alice-owncloud-id")).toBe(true);
	});

	it("rejects another authenticated identity using the same session ID", () => {
		expect(isMcpSessionOwnedBy("alice-owncloud-id", "bob-owncloud-id")).toBe(false);
	});
});

describe("sync_owncloud_docs MCP tool", () => {
	it("returns an MCP result immediately instead of waiting for indexing", async () => {
		const server = new McpServer({ name: "test", version: "1.0.0" });
		const credentials: BasicCredentials = { username: "alice", pat: "alice-pat" };
		registerSyncTool(
			server,
			{
				startSync: async () => ({ status: "started" }),
			},
			() => credentials,
		);
		const client = new Client({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);

		const result = await client.callTool({ name: "sync_owncloud_docs", arguments: {} });

		expect(result.isError).not.toBe(true);
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Synchronisation démarrée en arrière-plan. Son état et son bilan final sont visibles dans les journaux du service.",
			},
		]);
		await client.close();
		await server.close();
	});
});
