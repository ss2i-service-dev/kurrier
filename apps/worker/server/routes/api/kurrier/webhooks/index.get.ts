import { defineEventHandler } from "h3";
import { apiSuccess, validateApiKey } from "../../../../../lib/api-helpers";
import { db, webhooks } from "@db";
import {and, eq} from "drizzle-orm";

export default defineEventHandler(async (event) => {

	const { apiKey, ownerId } = await validateApiKey(event);
	// ss2i (controle d'acces, GHSA-cvh9-93mg-xvc9) : les webhooks du workspace de la cle seulement.
	const webhooksList = await db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.ownerId, ownerId), eq(webhooks.workspaceId, apiKey.workspaceId)));
	return apiSuccess(webhooksList);

});
