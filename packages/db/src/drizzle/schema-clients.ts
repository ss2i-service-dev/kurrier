import { sql } from "drizzle-orm";
import { boolean, index, integer, pgPolicy, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { identities, threads, users, workspaces } from "./schema";
import { identitySelectCondition, workspaceMutationPolicies } from "./helpers";
// ss2i : section « Clients » des boites pro. Cache des reponses de la CRM par adresse
// (resultats negatifs compris, rafraichis apres N jours), societes connues, et
// rattachement fil -> societe par identite. Aucun appel CRM a l'affichage : tout est
// calcule par le worker (crm-link). crm_email_matches et crm_companies ne sont lues que
// par les connexions admin : RLS activee sans politique, comme les tables OAuth.
export const crmEmailMatches = pgTable(
	"crm_email_matches",
	{
		email: text("email").primaryKey(),
		matched: boolean("matched").notNull().default(false),
		matchedBy: text("matched_by"),
		crmCompanyId: integer("crm_company_id"),
		crmContactId: integer("crm_contact_id"),
		contactName: text("contact_name"),
		checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("ix_crm_email_matches_company").on(t.crmCompanyId)],
).enableRLS();

export const crmCompanies = pgTable("crm_companies", {
	id: integer("id").primaryKey(),
	name: text("name").notNull(),
	ebpCustomerId: text("ebp_customer_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}).enableRLS();

export const threadClients = pgTable(
	"thread_clients",
	{
		threadId: uuid("thread_id")
			.references(() => threads.id, { onDelete: "cascade" })
			.notNull(),
		identityId: uuid("identity_id")
			.references(() => identities.id, { onDelete: "cascade" })
			.notNull(),
		crmCompanyId: integer("crm_company_id")
			.references(() => crmCompanies.id)
			.notNull(),
		ownerId: uuid("owner_id")
			.references(() => users.id)
			.notNull(),
		workspaceId: uuid("workspace_id")
			.references(() => workspaces.id)
			.notNull(),
		identityPublicId: text("identity_public_id").notNull(),
		matchedBy: text("matched_by"),
		lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
		// Detache a la main (rattachement par domaine errone) : le rattrapage ne le remet pas.
		// matchedBy = "manual" : rattache a la main, le rattrapage ne le retire jamais.
		detached: boolean("detached").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ name: "pk_thread_clients", columns: [t.threadId, t.identityId, t.crmCompanyId] }),
		index("ix_thread_clients_identity_company_activity").on(t.identityId, t.crmCompanyId, t.lastActivityAt),
		index("ix_thread_clients_identity_public").on(t.identityPublicId),
		index("ix_thread_clients_workspace").on(t.workspaceId),
		pgPolicy("thread_clients_select", {
			for: "select",
			to: "kurrier",
			using: identitySelectCondition(t, t.identityId),
		}),
		...workspaceMutationPolicies(t, "thread_clients"),
	],
).enableRLS();

// ss2i : dossier « Sans client » (migration 009). Par fil et identite pro, adresses
// exterieures humaines vues au dernier passage de crm-link (memes filtres que crm-match)
// et derniere activite. Lue par les connexions admin seulement (RLS sans politique).
export const threadCrmScans = pgTable(
	"thread_crm_scans",
	{
		threadId: uuid("thread_id")
			.references(() => threads.id, { onDelete: "cascade" })
			.notNull(),
		identityId: uuid("identity_id")
			.references(() => identities.id, { onDelete: "cascade" })
			.notNull(),
		externalAddresses: integer("external_addresses").notNull().default(0),
		lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
		scannedAt: timestamp("scanned_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		primaryKey({ name: "pk_thread_crm_scans", columns: [t.threadId, t.identityId] }),
		index("ix_thread_crm_scans_external")
			.on(t.identityId, t.lastActivityAt.desc(), t.threadId.desc())
			.where(sql`${t.externalAddresses} > 0`),
	],
).enableRLS();
