import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { config } from "./config.ts";
import type { QdrantManager } from "./qdrant.ts";

export function createMcpServer(qdrant: QdrantManager) {
	const server = new McpServer({
		name: "ocis-qdrant-rag",
		version: "1.0.0",
	});

	// Outil 1 : Recherche sémantique dans les documents ownCloud
	server.tool(
		"search_owncloud_docs",
		"Recherche sémantique dans les cours et documents synchronisés depuis ownCloud Infinite Scale",
		{
			query: z.string().describe("La question ou les mots-clés de recherche sémantique"),
			limit: z.number().optional().default(5).describe("Nombre d'extraits pertinents à retourner"),
			path_prefix: z
				.string()
				.optional()
				.describe("Filtre optionnel sur le chemin (ex: Cours/AP4/ ou Notes/)"),
		},
		async ({ query, limit, path_prefix }) => {
			try {
				const results = await qdrant.search(query, limit, path_prefix);
				if (results.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: "Aucun document pertinent trouvé dans le coffre ownCloud.",
							},
						],
					};
				}

				const formatted = results
					.map(
						(r, i) =>
							`### [${i + 1}] Source: ${r.path} (Score: ${r.score.toFixed(3)})\n${r.text}\n`,
					)
					.join("\n---\n\n");

				return {
					content: [
						{
							type: "text",
							text: formatted,
						},
					],
				};
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					isError: true,
					content: [
						{
							type: "text",
							text: `Erreur lors de la recherche Qdrant: ${message}`,
						},
					],
				};
			}
		},
	);

	// Serveur HTTP natif Bun avec transport Streamable HTTP
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined, // mode stateless
	});

	server.connect(transport);

	Bun.serve({
		port: config.mcpPort,
		async fetch(req) {
			const url = new URL(req.url);

			// Endpoint MCP Streamable HTTP standard
			if (url.pathname === "/mcp" || url.pathname === "/api/v1/mcp") {
				return transport.handleRequest(req);
			}

			// Healthcheck
			if (url.pathname === "/health") {
				return new Response(JSON.stringify({ status: "healthy" }), {
					headers: { "Content-Type": "application/json" },
				});
			}

			return new Response("Not Found", { status: 404 });
		},
	});

	console.log(`[MCP] Serveur Streamable HTTP à l'écoute sur http://0.0.0.0:${config.mcpPort}/mcp`);
}
