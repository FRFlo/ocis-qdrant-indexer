import { describe, expect, it } from "bun:test";
import { authenticateBasicRequest, parseBasicCredentials, userScopeId } from "./auth.ts";

describe("MCP user authentication", () => {
	it("extracts a username and PAT from HTTP Basic credentials", () => {
		const encoded = Buffer.from("alice:alice-pat").toString("base64");
		const request = new Request("http://localhost/mcp", {
			headers: { Authorization: `Basic ${encoded}` },
		});

		expect(parseBasicCredentials(request)).toEqual({
			username: "alice",
			pat: "alice-pat",
		});
	});

	it("rejects absent, non-Basic, malformed, and empty credentials", () => {
		expect(parseBasicCredentials(new Request("http://localhost/mcp"))).toBeNull();
		expect(
			parseBasicCredentials(
				new Request("http://localhost/mcp", {
					headers: { Authorization: "Bearer shared-token" },
				}),
			),
		).toBeNull();
		expect(
			parseBasicCredentials(
				new Request("http://localhost/mcp", {
					headers: { Authorization: "Basic not-base64" },
				}),
			),
		).toBeNull();
		expect(
			parseBasicCredentials(
				new Request("http://localhost/mcp", {
					headers: { Authorization: `Basic ${Buffer.from(":pat").toString("base64")}` },
				}),
			),
		).toBeNull();
	});

	it("derives stable opaque tenant IDs without exposing usernames", () => {
		const alice = userScopeId("alice");
		expect(userScopeId("alice")).toBe(alice);
		expect(userScopeId("bob")).not.toBe(alice);
		expect(alice).not.toContain("alice");
	});

	it("derives tenant scope from the ownCloud-validated identity", async () => {
		const request = new Request("http://localhost/mcp", {
			headers: {
				Authorization: `Basic ${Buffer.from("alice:alice-pat").toString("base64")}`,
				"X-User-Id": "bob",
			},
		});
		const resolveUserContext = async ({ username }: { username: string }) => ({
			userId: `verified-${username}`,
			username,
			drives: [{ id: "drive-a", name: "Alice", driveType: "personal" }],
		});

		await expect(authenticateBasicRequest(request, resolveUserContext)).resolves.toMatchObject({
			userId: "verified-alice",
			tenantId: userScopeId("verified-alice"),
			username: "alice",
		});
	});
});
