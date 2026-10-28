import { createHash } from "node:crypto";
import type { OcisUserContext } from "./ocis.ts";

export interface BasicCredentials {
	username: string;
	pat: string;
}

export interface AuthenticatedPrincipal extends BasicCredentials, OcisUserContext {
	tenantId: string;
}

export async function authenticateBasicRequest(
	request: Request,
	resolveUserContext: (credentials: BasicCredentials) => Promise<OcisUserContext>,
): Promise<AuthenticatedPrincipal | null> {
	const credentials = parseBasicCredentials(request);
	if (!credentials) return null;
	const userContext = await resolveUserContext(credentials);
	return {
		...credentials,
		...userContext,
		tenantId: userScopeId(userContext.userId),
	};
}

export function parseBasicCredentials(request: Request): BasicCredentials | null {
	const authorization = request.headers.get("authorization");
	const match = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
	if (!match?.[1]) return null;

	const encoded = match[1];
	const decoded = Buffer.from(encoded, "base64");
	if (decoded.toString("base64") !== encoded) return null;

	let value: string;
	try {
		value = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
	} catch {
		return null;
	}
	const separator = value.indexOf(":");
	if (separator <= 0 || separator === value.length - 1) return null;

	const username = value.slice(0, separator);
	const pat = value.slice(separator + 1);
	if (
		[...username, ...pat].some((character) => {
			const code = character.charCodeAt(0);
			return code < 0x20 || code === 0x7f;
		})
	) {
		return null;
	}
	return { username, pat };
}

export function userScopeId(ownCloudUserId: string): string {
	return createHash("sha256").update(ownCloudUserId).digest("hex").slice(0, 32);
}
