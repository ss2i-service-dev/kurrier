-- ss2i : regles de nettoyage automatique depuis une recherche (docs/plans/nettoyage-auto-recherche.md).
-- Une ligne = une regle permanente : tout fil qui correspond a la recherche stricte `query` et dont le
-- message le plus recent depasse `retention_days` part a la Corbeille (tick du worker). L'age est evalue au
-- moment du tick : rien n'est ecrit sur mailbox_threads (expires_at et son trigger restent a l'archivage).
-- mailbox_id null = tous les dossiers nettoyables (inbox, archive, custom). Aucun slug ni workspace stocke :
-- le worker relit tout depuis l'identite, dont le proprietaire doit rester celui de la regle. Idempotent.
SET lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS public.cleanup_rules (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	owner_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
	identity_id uuid NOT NULL REFERENCES public.identities (id) ON DELETE CASCADE,
	mailbox_id uuid REFERENCES public.mailboxes (id) ON DELETE CASCADE,
	query text NOT NULL,
	has_attachment boolean NOT NULL DEFAULT false,
	only_unread boolean NOT NULL DEFAULT false,
	retention_days integer NOT NULL,
	paused boolean NOT NULL DEFAULT false,
	last_run_at timestamptz,
	last_trashed_at timestamptz,
	trashed_count integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT cleanup_rules_retention_days_check CHECK (retention_days BETWEEN 1 AND 3650),
	-- btrim(query, E' \t\r\n') : btrim seul ne retire que les espaces, le code enregistre la requete passee au trim() JS.
	-- Un `*` seul ou une requete trop courte tombent sous la longueur minimale de 3 : pas de contrainte a part.
	CONSTRAINT cleanup_rules_query_length_check CHECK (char_length(btrim(query, E' \t\r\n')) BETWEEN 3 AND 200)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cleanup_rules_scope ON public.cleanup_rules
	(identity_id, coalesce(mailbox_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(query, E' \t\r\n')), has_attachment, only_unread);
CREATE INDEX IF NOT EXISTS ix_cleanup_rules_identity ON public.cleanup_rules (identity_id);
GRANT ALL ON public.cleanup_rules TO kurrier;
ALTER TABLE public.cleanup_rules ENABLE ROW LEVEL SECURITY;
-- Propriete verrouillee dans la table : la regle et l'identite appartiennent au meme utilisateur, et le
-- dossier eventuel est un dossier de cette identite.
-- SELECT et UPDATE (USING) voient aussi la regle d'un ancien proprietaire de l'identite : l'on conflict
-- do update d'insertCleanupRule (cleanup-store.ts) exige que la ligne existante les passe pour que le
-- proprietaire actuel la reprenne. Le WITH CHECK impose toujours owner_id = sub : sans reprise, ni pause ni
-- modification ; DELETE reste au seul auteur. Les actions web filtrent en plus owner_id = user.id.
DROP POLICY IF EXISTS "cleanup_rules_select_owner" ON public.cleanup_rules;
CREATE POLICY "cleanup_rules_select_owner" ON public.cleanup_rules AS PERMISSIVE FOR SELECT TO "kurrier" USING ("cleanup_rules"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid OR exists (select 1 from public.identities i where i.id = "cleanup_rules"."identity_id" and i.owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid));
DROP POLICY IF EXISTS "cleanup_rules_delete_owner" ON public.cleanup_rules;
CREATE POLICY "cleanup_rules_delete_owner" ON public.cleanup_rules AS PERMISSIVE FOR DELETE TO "kurrier" USING ("cleanup_rules"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);
DROP POLICY IF EXISTS "cleanup_rules_insert_owner" ON public.cleanup_rules;
CREATE POLICY "cleanup_rules_insert_owner" ON public.cleanup_rules AS PERMISSIVE FOR INSERT TO "kurrier" WITH CHECK ("cleanup_rules"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid AND exists (select 1 from public.identities i where i.id = "cleanup_rules"."identity_id" and i.owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid) AND ("cleanup_rules"."mailbox_id" IS NULL OR exists (select 1 from public.mailboxes m where m.id = "cleanup_rules"."mailbox_id" and m.identity_id = "cleanup_rules"."identity_id")));
DROP POLICY IF EXISTS "cleanup_rules_update_owner" ON public.cleanup_rules;
CREATE POLICY "cleanup_rules_update_owner" ON public.cleanup_rules AS PERMISSIVE FOR UPDATE TO "kurrier" USING ("cleanup_rules"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid OR exists (select 1 from public.identities i where i.id = "cleanup_rules"."identity_id" and i.owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid)) WITH CHECK ("cleanup_rules"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid AND exists (select 1 from public.identities i where i.id = "cleanup_rules"."identity_id" and i.owner_id = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid) AND ("cleanup_rules"."mailbox_id" IS NULL OR exists (select 1 from public.mailboxes m where m.id = "cleanup_rules"."mailbox_id" and m.identity_id = "cleanup_rules"."identity_id")));
