import { describe, expect, it } from "bun:test";
import { isMcpSessionOwnedBy } from "./mcp.ts";

describe("MCP session ownership", () => {
	it("accepts requests from the identity that created the session", () => {
		expect(isMcpSessionOwnedBy("alice-owncloud-id", "alice-owncloud-id")).toBe(true);
	});

	it("rejects another authenticated identity using the same session ID", () => {
		expect(isMcpSessionOwnedBy("alice-owncloud-id", "bob-owncloud-id")).toBe(false);
	});
});
