import { defineEventHandler, getRouterParam } from "h3";
import {
	apiSuccess,
	apiError,
	validateApiKey,
} from "../../../../../lib/api-helpers";
import { db, webhooks } from "@db";
import {and, eq} from "drizzle-orm";

export default defineEventHandler(async (event) => {

	const { apiKey, ownerId } = await validateApiKey(event);
	const id = getRouterParam(event, "id");
	if (!id) {
		return apiError(400, "INVALID_WEBHOOK_ID", "Webhook id is required");
	}
	// Access control (GHSA-cvh9-93mg-xvc9): within the workspace of the key only.
	const scope = (webhookId: string) =>
		and(eq(webhooks.id, webhookId), eq(webhooks.ownerId, ownerId), eq(webhooks.workspaceId, apiKey.workspaceId));
	const [existing] = await db
		.select()
		.from(webhooks)
		.where(scope(String(id)))
		.limit(1);
	if (!existing) {
		return apiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
	}
	await db
		.delete(webhooks)
		.where(scope(existing.id));
	return apiSuccess({
		id: existing.id,
		deleted: true,
	});

});
