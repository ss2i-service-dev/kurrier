-- ss2i : desinscription et blocage d'expediteurs.
-- 1. Abonnements : la cle d'unicite passe de (workspace, cle) a (workspace, utilisateur, cle) ;
--    deux utilisateurs d'un meme workspace recevant la meme liste se disputaient la ligne
--    (le second ecrasait l'URL du premier sans devenir proprietaire, donc sans bouton).
-- 2. blocked_senders : adresses et domaines bloques par utilisateur (domaine = domaine exact
--    et sous-domaines). Lue par le worker a la reception (corbeille d'office), geree par le web.
-- Une seule transaction : un echec entre le DROP et le CREATE de l'index ne laisse pas la table sans unicite.
BEGIN;
DROP INDEX IF EXISTS "uniq_mail_subscriptions_workspace_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_mail_subscriptions_workspace_key" ON "mail_subscriptions" USING btree ("workspace_id","owner_id","subscription_key");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "blocked_senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid DEFAULT NULLIF(current_setting('request.jwt.claim.sub'::text, true), ''::text)::uuid NOT NULL,
	"workspace_id" uuid DEFAULT NULLIF(current_setting('request.jwt.claim.workspace_id'::text, true), ''::text)::uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_senders_kind_check" CHECK ("kind" IN ('address', 'domain'))
);--> statement-breakpoint
ALTER TABLE "blocked_senders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "blocked_senders" ADD CONSTRAINT "blocked_senders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_senders" ADD CONSTRAINT "blocked_senders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_blocked_senders_owner_value" ON "blocked_senders" USING btree ("owner_id","kind","value");--> statement-breakpoint
CREATE POLICY "blocked_senders_select_owner" ON "blocked_senders" AS PERMISSIVE FOR SELECT TO "kurrier" USING ("blocked_senders"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "blocked_senders_insert_owner" ON "blocked_senders" AS PERMISSIVE FOR INSERT TO "kurrier" WITH CHECK ("blocked_senders"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid AND "blocked_senders"."workspace_id" = nullif(current_setting('request.jwt.claim.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "blocked_senders_delete_owner" ON "blocked_senders" AS PERMISSIVE FOR DELETE TO "kurrier" USING ("blocked_senders"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);
COMMIT;
