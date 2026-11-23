import { defineEventHandler, getRouterParam } from "h3";
import {apiError, apiSuccess, validateApiKey} from "../../../../../lib/api-helpers";
import { db, webhooks } from "@db";
import {and, eq} from "drizzle-orm";

export default defineEventHandler(async (event) => {

	const { apiKey, ownerId } = await validateApiKey(event);
	const id = getRouterParam(event, "id");
	// ss2i (controle d'acces, GHSA-cvh9-93mg-xvc9) : dans le workspace de la cle seulement.
	const [webhook] = await db
		.select()
		.from(webhooks)
		.where(
			and(
				eq(webhooks.id, String(id)),
				eq(webhooks.ownerId, ownerId),
				eq(webhooks.workspaceId, apiKey.workspaceId),
			),
		)
		.limit(1);
	if (!webhook) {
		return apiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found");
	}
	return apiSuccess(webhook);

});
