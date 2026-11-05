import { defineEventHandler, readBody } from "h3";
import {
	apiSuccess,
	apiError,
	validateApiKey, validateIdentityOwnership,
} from "../../../../../lib/api-helpers";
import { assertPublicUrl } from "@common/safe-http";
import { db, WebhookCreateSchema, WebhookInsertEntity, webhooks } from "@db";

export default defineEventHandler(async (event) => {

	const { ownerId } = await validateApiKey(event);
	const body = await readBody(event).catch(() => ({}));
	const parsed = WebhookCreateSchema.safeParse(body);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
			code: issue.code,
		}));
		return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body", issues);
	}
	const data = parsed.data;
	if (!data.url) {
		return apiError(400, "MISSING_URL", "Field `url` is required");
	}
	if (!data.events || data.events.length === 0) {
		return apiError(
			400,
			"MISSING_EVENTS",
			"Field `events` must have at least one event",
		);
	}
	// Access control: identity required, belonging to the API key; the webhook takes its
	// workspace. Without an identity, the worker would call it for all incoming mail.
	if (!data.identityId) {
		return apiError(400, "MISSING_IDENTITY", "Field `identityId` is required");
	}
	const identity = await validateIdentityOwnership({
		identityId: data.identityId,
		ownerId,
	});
	// Public address only (re-checked on each send, lib/webhooks/message.received.ts).
	const url = await assertPublicUrl(String(data.url), { allowHttp: true }).catch(() => null);
	if (!url) {
		return apiError(400, "INVALID_URL", "Field `url` must be a public http(s) address");
	}
	const insertPayload = {
		ownerId,
		workspaceId: identity.workspaceId,
		url: url.toString(),
		description: data.description ?? null,
		enabled: data.enabled ?? true,
		identityId: identity.id,
		events: data.events,
		metaData: data.metaData ?? null,
	};
	const [created] = await db
		.insert(webhooks)
		.values(insertPayload as WebhookInsertEntity)
		.returning();
	return apiSuccess(created);

});
