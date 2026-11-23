import { defineEventHandler } from "h3";
import { apiSuccess, validateApiKey } from "../../../../../lib/api-helpers";
import { db, webhooks } from "@db";
import {and, eq} from "drizzle-orm";

export default defineEventHandler(async (event) => {

	const { apiKey, ownerId } = await validateApiKey(event);
	// Access control (GHSA-cvh9-93mg-xvc9): the webhooks of the workspace of the key only.
	const webhooksList = await db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.ownerId, ownerId), eq(webhooks.workspaceId, apiKey.workspaceId)));
	return apiSuccess(webhooksList);

});
