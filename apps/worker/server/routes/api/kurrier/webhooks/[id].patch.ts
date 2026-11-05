import { defineEventHandler, getRouterParam, readBody } from "h3";
import {
	apiSuccess,
	apiError,
	validateApiKey, validateIdentityOwnership,
} from "../../../../../lib/api-helpers";
import { assertPublicUrl } from "@common/safe-http";
import { db, WebhookInsertEntity, webhooks, WebhookUpdateSchema } from "@db";
import {and, eq} from "drizzle-orm";

export default defineEventHandler(async (event) => {

	const { ownerId } = await validateApiKey(event);
	const id = getRouterParam(event, "id");
	if (!id) {
		return apiError(400, "INVALID_WEBHOOK_ID", "Webhook id is required");
	}
	const body = await readBody(event).catch(() => ({}));
	const parsed = WebhookUpdateSchema.safeParse(body);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
			code: issue.code,
		}));
		return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body", issues);
	}
	const [existing] = await db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.id, String(id)), eq(webhooks.ownerId, ownerId)))
		.limit(1);
	if (!existing) {
		return apiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
	}
	// Access control: owner, workspace and id cannot be changed; a new identity must belong to
	// the API key (the webhook takes its workspace).
	const { id: _id, ownerId: _ownerId, workspaceId: _workspaceId, ...patch } = parsed.data as Record<string, any>;
	if ("url" in patch) {
		const url = await assertPublicUrl(String(patch.url ?? ""), { allowHttp: true }).catch(() => null);
		if (!url) return apiError(400, "INVALID_URL", "Field `url` must be a public http(s) address");
		patch.url = url.toString();
	}
	if ("identityId" in patch) {
		if (!patch.identityId) {
			return apiError(400, "MISSING_IDENTITY", "Field `identityId` cannot be empty");
		}
		const identity = await validateIdentityOwnership({ identityId: String(patch.identityId), ownerId });
		patch.identityId = identity.id;
		patch.workspaceId = identity.workspaceId;
	}
	const [updated] = await db
		.update(webhooks)
		.set(patch as WebhookInsertEntity)
		.where(and(eq(webhooks.id, existing.id), eq(webhooks.ownerId, ownerId)))
		.returning();
	return apiSuccess(updated);

});
