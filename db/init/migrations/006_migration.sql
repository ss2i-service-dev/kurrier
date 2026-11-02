-- ss2i : section « Clients » des boites pro (dossiers virtuels par societe de la CRM).
-- crm_email_matches : cache des reponses de la CRM (api/lore/email-match) par adresse,
-- resultats negatifs compris, rafraichi apres N jours. crm_companies : societes vues.
-- thread_clients : rattachement fil -> societe par identite, calcule par le worker
-- (file crm-link) a partir des adresses exterieures ; `detached` memorise un
-- detachement manuel que le rattrapage ne remet pas. Les deux premieres tables ne sont
-- lues que par les connexions admin : RLS activee sans politique (comme mcp_oauth_*).
CREATE TABLE "crm_email_matches" (
	"email" text PRIMARY KEY NOT NULL,
	"matched" boolean DEFAULT false NOT NULL,
	"matched_by" text,
	"crm_company_id" integer,
	"crm_contact_id" integer,
	"contact_name" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_email_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crm_companies" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"ebp_customer_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crm_companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "thread_clients" (
	"thread_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"crm_company_id" integer NOT NULL,
	"owner_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"identity_public_id" text NOT NULL,
	"matched_by" text,
	"last_activity_at" timestamp with time zone NOT NULL,
	"detached" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_thread_clients" PRIMARY KEY("thread_id","identity_id","crm_company_id")
);
--> statement-breakpoint
ALTER TABLE "thread_clients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "thread_clients" ADD CONSTRAINT "thread_clients_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_clients" ADD CONSTRAINT "thread_clients_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_clients" ADD CONSTRAINT "thread_clients_crm_company_id_crm_companies_id_fk" FOREIGN KEY ("crm_company_id") REFERENCES "public"."crm_companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_clients" ADD CONSTRAINT "thread_clients_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_clients" ADD CONSTRAINT "thread_clients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_crm_email_matches_company" ON "crm_email_matches" USING btree ("crm_company_id");--> statement-breakpoint
CREATE INDEX "ix_thread_clients_identity_company_activity" ON "thread_clients" USING btree ("identity_id","crm_company_id","last_activity_at");--> statement-breakpoint
CREATE INDEX "ix_thread_clients_identity_public" ON "thread_clients" USING btree ("identity_public_id");--> statement-breakpoint
CREATE INDEX "ix_thread_clients_workspace" ON "thread_clients" USING btree ("workspace_id");--> statement-breakpoint
CREATE POLICY "thread_clients_select" ON "thread_clients" AS PERMISSIVE FOR SELECT TO "kurrier" USING (
	"thread_clients"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid
	AND EXISTS (
		SELECT 1
		FROM identities i
		WHERE
			i.id = "thread_clients"."identity_id"
			AND i.workspace_id = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid
			AND (
				i.shared_with_workspace = true
				OR EXISTS (
					SELECT 1
					FROM workspace_identity_members wim
					WHERE
						wim.workspace_id = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid
						AND wim.user_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
						AND wim.identity_id = i.id
				)
			)
	)
);--> statement-breakpoint
CREATE POLICY "thread_clients_insert_workspace" ON "thread_clients" AS PERMISSIVE FOR INSERT TO "kurrier" WITH CHECK ("thread_clients"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "thread_clients_update_workspace" ON "thread_clients" AS PERMISSIVE FOR UPDATE TO "kurrier" USING ("thread_clients"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid) WITH CHECK ("thread_clients"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "thread_clients_delete_workspace" ON "thread_clients" AS PERMISSIVE FOR DELETE TO "kurrier" USING ("thread_clients"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid);
