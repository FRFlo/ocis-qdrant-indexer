import { describe, expect, it } from "bun:test";
import { hasValidBearerToken } from "./mcp.ts";

describe("MCP Bearer authentication", () => {
	it("accepts the configured bearer token", () => {
		const request = new Request("http://localhost/mcp", {
			headers: { Authorization: "Bearer secret-token" },
		});

		expect(hasValidBearerToken(request, "secret-token")).toBe(true);
	});

	it("rejects missing, malformed, and incorrect tokens", () => {
		expect(hasValidBearerToken(new Request("http://localhost/mcp"), "secret-token")).toBe(false);
		expect(
			hasValidBearerToken(
				new Request("http://localhost/mcp", {
					headers: { Authorization: "Basic secret-token" },
				}),
				"secret-token",
			),
		).toBe(false);
		expect(
			hasValidBearerToken(
				new Request("http://localhost/mcp", {
					headers: { Authorization: "Bearer wrong-token" },
				}),
				"secret-token",
			),
		).toBe(false);
	});
});
