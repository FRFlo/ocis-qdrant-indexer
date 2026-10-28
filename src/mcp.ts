import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { config } from "./config.ts";
import {
	authenticateBasicRequest,
	type AuthenticatedPrincipal,
	type BasicCredentials,
} from "./auth.ts";
import { OcisApiError } from "./ocis.ts";
import type { QdrantManager } from "./qdrant.ts";
import type { UserIndexer } from "./user-indexer.ts";

interface McpSession {
	userId: string;
	server: McpServer;
	transport: WebStandardStreamableHTTPServerTransport;
	updateCredentials: (credentials: BasicCredentials) => void;
}

export function createMcpServer(qdrant: QdrantManager, userIndexer: UserIndexer) {
	const sessions = new Map<string, McpSession>();

	function buildSession(userId: string, credentials: BasicCredentials): McpSession {
		const server = new McpServer({
			name: "ocis-qdrant-rag",
			version: "1.0.0",
		});
		let currentCredentials = credentials;

		// Outil 1 : Recherche sémantique dans les documents ownCloud
		server.registerTool(
			"search_owncloud_docs",
			{
				description:
					"Recherche sémantique dans les cours et documents synchronisés depuis ownCloud Infinite Scale",
				inputSchema: {
					query: z.string().describe("La question ou les mots-clés de recherche sémantique"),
					limit: z
						.number()
						.int()
						.min(1)
						.max(100)
						.optional()
						.default(5)
						.describe("Nombre d'extraits pertinents à retourner (1 à 100)"),
					path_prefix: z
						.string()
						.optional()
						.describe("Filtre optionnel sur le chemin (ex: Cours/AP4/ ou Notes/)"),
				},
				annotations: { readOnlyHint: true, openWorldHint: false },
			},
			async ({ query, limit, path_prefix }) => {
				try {
					const results = await userIndexer.search(currentCredentials, query, limit, path_prefix);
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
								`### [${i + 1}] ${r.source} — ${r.path} (Score: ${r.score.toFixed(3)})\n` +
								`Lien: ${r.webdavUrl || "indisponible"}\n` +
								`Dernière modification: ${r.lastModified || "inconnue"} | Taille: ${r.sizeBytes ?? "inconnue"} octets\n\n${r.text}\n`,
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

		server.registerTool(
			"sync_owncloud_docs",
			{
				description:
					"Synchronise les fichiers ownCloud accessibles par le compte authentifié vers son index privé",
				inputSchema: {},
				annotations: { readOnlyHint: false, openWorldHint: false },
			},
			async () => {
				try {
					const result = await userIndexer.sync(currentCredentials);
					return {
						content: [
							{
								type: "text",
								text:
									`Synchronisation terminée pour ${result.spaces} espace(s): ` +
									`${result.checked} fichier(s) vérifié(s), ${result.indexed} indexé(s), ` +
									`${result.deleted} supprimé(s).`,
							},
						],
					};
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						isError: true,
						content: [{ type: "text", text: `Erreur de synchronisation ownCloud: ${message}` }],
					};
				}
			},
		);

		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: () => crypto.randomUUID(),
		});

		server.connect(transport);
		return {
			userId,
			server,
			transport,
			updateCredentials(nextCredentials) {
				currentCredentials = nextCredentials;
			},
		};
	}

	Bun.serve({
		port: config.mcpPort,
		async fetch(req) {
			const url = new URL(req.url);

			// Endpoint MCP Streamable HTTP standard
			if (url.pathname === "/mcp" || url.pathname === "/api/v1/mcp") {
				let principal: AuthenticatedPrincipal;
				try {
					const resolved = await authenticateBasicRequest(req, (credentials) =>
						userIndexer.authenticate(credentials),
					);
					if (!resolved) {
						return new Response("Unauthorized", {
							status: 401,
							headers: { "WWW-Authenticate": 'Basic realm="ownCloud MCP"' },
						});
					}
					principal = resolved;
				} catch (error) {
					const unauthorized = error instanceof OcisApiError && [401, 403].includes(error.status);
					return new Response(
						unauthorized ? "Unauthorized" : "Authentication service unavailable",
						{
							status: unauthorized ? 401 : 503,
							headers: unauthorized
								? { "WWW-Authenticate": 'Basic realm="ownCloud MCP"' }
								: undefined,
						},
					);
				}

				const sessionId = req.headers.get("mcp-session-id");
				let session = sessionId ? sessions.get(sessionId) : undefined;
				if (session && !isMcpSessionOwnedBy(session.userId, principal.userId)) {
					return new Response("Forbidden: MCP session belongs to another user", {
						status: 403,
					});
				}
				if (!session) {
					session = buildSession(principal.userId, {
						username: principal.username,
						pat: principal.pat,
					});
				}
				session.updateCredentials({ username: principal.username, pat: principal.pat });

				const response = await session.transport.handleRequest(req);
				const sid = response.headers.get("mcp-session-id") || session.transport.sessionId;
				if (sid && !sessions.has(sid)) {
					sessions.set(sid, session);
					session.transport.onclose = () => {
						sessions.delete(sid);
					};
				}
				return response;
			}

			// Check the configured vector-store dependency without exposing connection details.
			if (url.pathname === "/health") {
				try {
					await qdrant.client.getCollections();
					return new Response(
						JSON.stringify({
							status: "healthy",
							service: "mcp",
							dependencies: { qdrant: "healthy" },
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				} catch {
					return new Response(
						JSON.stringify({
							status: "unhealthy",
							service: "mcp",
							dependencies: { qdrant: "unhealthy" },
						}),
						{
							status: 503,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
			}

			return new Response("Not Found", { status: 404 });
		},
	});

	console.log(`[MCP] Serveur Streamable HTTP à l'écoute sur http://0.0.0.0:${config.mcpPort}/mcp`);
}

export function isMcpSessionOwnedBy(sessionUserId: string, requestUserId: string): boolean {
	return sessionUserId === requestUserId;
}
