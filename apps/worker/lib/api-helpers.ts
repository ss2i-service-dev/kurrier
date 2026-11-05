import { H3Event, createError, readRawBody } from "h3";
import {db, apiKeys, secretsMeta, getSecretAdmin, identities} from "@db";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";

export function apiSuccess(data: any = null) {
	return {
		success: true,
		data,
	};
}

export function apiError(
	statusCode: number,
	code: string,
	message: string,
	issues?: any,
) {
	throw createError({
		statusCode,
		statusMessage: message,
		data: {
			success: false,
			error: {
				code,
				message,
				issues,
			},
		},
	});
}

export async function validateJSONBody(event: H3Event) {
	const raw = (await readRawBody(event)) || "";
	let json: any;
	try {
		json = JSON.parse(raw);
	} catch (e) {
		throw createError({
			statusCode: 400,
			statusMessage: "Invalid JSON in request body",
		});
	}

	return { raw, json };
}


function safeEqual(a: string, b: string) {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);

	if (ab.length !== bb.length) return false;

	return crypto.timingSafeEqual(ab, bb);
}

export async function validateApiKey(event: H3Event) {
	const auth = event.node.req.headers.authorization;

	if (!auth || !auth.startsWith("Bearer ")) {
		throw createError({
			statusCode: 401,
			statusMessage: "Missing or invalid Authorization header",
		});
	}

	const token = auth.replace("Bearer ", "").trim();
	return validateApiKeyToken(token);
}

// Validates an API key from its value alone, for callers that already extracted the token
// (the MCP endpoint). Same checks as the header-based path.
export async function validateApiKeyToken(token: string) {
	const parts = token.split(".");
	if (parts.length < 2) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid API key format",
		});
	}

	const prefix = parts[0];
	const rest = parts.slice(1).join(".");
	const last4 = rest.slice(-4);

	if (!prefix || last4.length !== 4) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid API key format",
		});
	}

	const [key] = await db
		.select()
		.from(apiKeys)
		.where(and(eq(apiKeys.keyPrefix, prefix), eq(apiKeys.keyLast4, last4)))
		.limit(1);

	if (!key) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid API key",
		});
	}

	if (key.revokedAt) {
		throw createError({
			statusCode: 401,
			statusMessage: "API key has been revoked",
		});
	}
	// An expired key is refused everywhere.
	if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now()) {
		throw createError({
			statusCode: 401,
			statusMessage: "API key has expired",
		});
	}

	const [secretMeta] = await db
		.select()
		.from(secretsMeta)
		.where(eq(secretsMeta.id, key.secretId))
		.limit(1);

	if (!secretMeta) {
		throw createError({
			statusCode: 401,
			statusMessage: "API key secret not found",
		});
	}

	// The stored value is {"rawKey": ...} (see addApiKey): comparing against String(vault)
	// would yield "[object Object]" and reject every key.
	const actualSecret = await getSecretAdmin(secretMeta.id);
	let rawKey = "";
	try {
		rawKey = String(JSON.parse(String(actualSecret?.vault?.decrypted_secret ?? "{}"))?.rawKey ?? "");
	} catch {
		rawKey = "";
	}
	if (!rawKey || !safeEqual(rawKey, token)) {
		throw createError({
			statusCode: 401,
			statusMessage: "Invalid API key",
		});
	}

	return {
		apiKey: key,
		secret: rawKey,
		ownerId: key.ownerId,
	};
}


export async function validateIdentityOwnership(opts: {
	identityId: string;
	ownerId: string;
}) {

	const [identity] = await db
		.select()
		.from(identities)
		.where(
			and(
				eq(identities.id, opts.identityId),
				eq(identities.ownerId, opts.ownerId),
			),
		)
		.limit(1);

	if (!identity) {
		throw createError({
			statusCode: 403,
			statusMessage: "Identity not found or access denied",
		});
	}
	return identity;

}
