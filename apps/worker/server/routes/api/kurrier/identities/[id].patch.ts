import { defineEventHandler, getRouterParam, readBody } from "h3";
import {
	apiSuccess,
	apiError,
	validateApiKey,
	validateIdentityOwnership
} from "../../../../../lib/api-helpers";
import { db, identities, IdentityCreate, IdentityUpdateSchema, providers, smtpAccounts } from "@db";
import { and, eq } from "drizzle-orm";

// Access control: fields editable through the API. The full schema would allow changing the
// owner, workspace, address, verification status, or plugging the identity into another
// user's SMTP account or provider.
const EDITABLE = ["displayName", "metaData", "sharedWithWorkspace", "smtpAccountId", "providerId"] as const;

export default defineEventHandler(async (event) => {

	const { ownerId } = await validateApiKey(event);
	const id = getRouterParam(event, "id");
	if (!id) {
		return apiError(400, "INVALID_IDENTITY_ID", "Identity id is required");
	}
	const body = await readBody(event).catch(() => ({}));
	const parsed = IdentityUpdateSchema.safeParse(body);
	if (!parsed.success) {
		const issues = parsed.error.issues.map((issue) => ({
			path: issue.path.join("."),
			message: issue.message,
			code: issue.code,
		}));
		return apiError(400, "INVALID_REQUEST_BODY", "Invalid request body", issues);
	}
	const identity = await validateIdentityOwnership({
		identityId: String(id),
		ownerId,
	});
	const data = parsed.data as Record<string, unknown>;
	const refused = Object.keys(data).filter(
		(k) => data[k] !== undefined && !(EDITABLE as readonly string[]).includes(k),
	);
	if (refused.length) {
		return apiError(400, "FIELD_NOT_EDITABLE", `Fields not editable: ${refused.join(", ")}`);
	}
	const patch: Record<string, unknown> = {};
	for (const k of EDITABLE) if (data[k] !== undefined) patch[k] = data[k];
	// SMTP account or provider: same owner and same workspace as the identity.
	if (patch.smtpAccountId) {
		const [account] = await db
			.select({ id: smtpAccounts.id })
			.from(smtpAccounts)
			.where(
				and(
					eq(smtpAccounts.id, String(patch.smtpAccountId)),
					eq(smtpAccounts.ownerId, ownerId),
					eq(smtpAccounts.workspaceId, identity.workspaceId),
				),
			)
			.limit(1);
		if (!account) return apiError(403, "SMTP_ACCOUNT_NOT_ALLOWED", "SMTP account not found or access denied");
	}
	if (patch.providerId) {
		const [provider] = await db
			.select({ id: providers.id })
			.from(providers)
			.where(
				and(
					eq(providers.id, String(patch.providerId)),
					eq(providers.ownerId, ownerId),
					eq(providers.workspaceId, identity.workspaceId),
				),
			)
			.limit(1);
		if (!provider) return apiError(403, "PROVIDER_NOT_ALLOWED", "Provider not found or access denied");
	}
	if (!Object.keys(patch).length) return apiSuccess(identity);
	const [updated] = await db
		.update(identities)
		.set(patch as Partial<IdentityCreate>)
		.where(and(eq(identities.id, identity.id), eq(identities.ownerId, ownerId)))
		.returning();
	return apiSuccess(updated);

});
