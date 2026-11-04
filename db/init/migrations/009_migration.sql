-- ss2i : rattachement manuel d'un fil a un client et dossier « Sans client » (OI 10270).
--
-- 1. thread_clients.matched_by = 'manual' : rattachement pose a la main (glisser-deposer sur un
--    client, « Rattacher a un client... », outil MCP link_thread_to_client). crm-link ne retire
--    jamais une ligne manuelle et ne change pas son matched_by (apps/worker/lib/crm/link-thread.ts).
--    Aucune colonne nouvelle : seule la fusion des fils (ci-dessous) devait apprendre la regle.
--
-- 2. thread_crm_scans : par fil et par identite pro, le nombre d'adresses exterieures humaines
--    (memes filtres que crm-match : hors domaines internes et automates, en-tetes transferes
--    compris) vues au dernier passage de crm-link, et la derniere activite du fil. Le dossier
--    virtuel « Sans client » = fils avec au moins une adresse exterieure et aucun rattachement non
--    detache, hors corbeille et spam. Calcule par le worker (le filtre est en TypeScript) ; rempli
--    pour l'existant par la passe de rattrapage (LINK_RULES_VERSION 3). Lue par les connexions
--    admin seulement : RLS activee sans politique, comme crm_companies.
CREATE TABLE IF NOT EXISTS "thread_crm_scans" (
	"thread_id" uuid NOT NULL REFERENCES "public"."threads"("id") ON DELETE cascade,
	"identity_id" uuid NOT NULL REFERENCES "public"."identities"("id") ON DELETE cascade,
	"external_addresses" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_thread_crm_scans" PRIMARY KEY ("thread_id", "identity_id")
);
ALTER TABLE "thread_crm_scans" ENABLE ROW LEVEL SECURITY;
-- Dossier « Sans client » : parcours dans l'ordre d'affichage, fils avec adresse exterieure seuls.
CREATE INDEX IF NOT EXISTS "ix_thread_crm_scans_external" ON "thread_crm_scans" USING btree
	("identity_id", "last_activity_at" DESC, "thread_id" DESC) WHERE "external_addresses" > 0;

-- 3. ss2i_merge_threads (migration 008) : rattachement manuel conserve, scans fusionnes.
CREATE OR REPLACE FUNCTION public.ss2i_merge_threads(p_target uuid, p_sources uuid[])
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
	v_sources uuid[];
	v_owner uuid;
	v_moved integer;
BEGIN
	SELECT array_agg(DISTINCT s) INTO v_sources
	FROM unnest(p_sources) AS s
	WHERE s IS NOT NULL AND s <> p_target;
	IF v_sources IS NULL THEN
		RETURN 0;
	END IF;

	PERFORM 1 FROM threads WHERE id = p_target OR id = ANY (v_sources) ORDER BY id FOR UPDATE;
	SELECT owner_id INTO v_owner FROM threads WHERE id = p_target;
	IF v_owner IS NULL THEN
		RETURN -1;
	END IF;
	IF EXISTS (SELECT 1 FROM threads WHERE id = ANY (v_sources) AND owner_id <> v_owner) THEN
		RAISE EXCEPTION 'ss2i_merge_threads: fils de proprietaires differents (cible %)', p_target;
	END IF;

	UPDATE messages SET thread_id = p_target WHERE thread_id = ANY (v_sources);
	GET DIAGNOSTICS v_moved = ROW_COUNT;

	INSERT INTO mailbox_thread_labels (thread_id, mailbox_id, label_id, owner_id, workspace_id, created_at)
	SELECT p_target, mailbox_id, label_id, min(owner_id::text)::uuid, min(workspace_id::text)::uuid, min(created_at)
	FROM mailbox_thread_labels
	WHERE thread_id = ANY (v_sources)
	GROUP BY mailbox_id, label_id
	ON CONFLICT (thread_id, mailbox_id, label_id) DO NOTHING;
	DELETE FROM mailbox_thread_labels WHERE thread_id = ANY (v_sources);

	-- Un rattachement detache a la main le reste apres la fusion ; un rattachement manuel
	-- (matched_by = 'manual') reste manuel, sinon le passage suivant de crm-link le retirerait.
	INSERT INTO thread_clients (thread_id, identity_id, crm_company_id, owner_id, workspace_id,
		identity_public_id, matched_by, last_activity_at, detached, created_at, updated_at)
	SELECT p_target, identity_id, crm_company_id, min(owner_id::text)::uuid, min(workspace_id::text)::uuid,
		min(identity_public_id),
		CASE WHEN bool_or(matched_by = 'manual') THEN 'manual' ELSE min(matched_by) END,
		max(last_activity_at), bool_or(detached), min(created_at), now()
	FROM thread_clients
	WHERE thread_id = ANY (v_sources)
	GROUP BY identity_id, crm_company_id
	ON CONFLICT (thread_id, identity_id, crm_company_id) DO UPDATE SET
		matched_by = CASE WHEN EXCLUDED.matched_by = 'manual' THEN 'manual' ELSE thread_clients.matched_by END,
		last_activity_at = greatest(thread_clients.last_activity_at, EXCLUDED.last_activity_at),
		detached = thread_clients.detached OR EXCLUDED.detached,
		updated_at = now();
	DELETE FROM thread_clients WHERE thread_id = ANY (v_sources);

	-- Dossier « Sans client » : le fil fusionne a une adresse exterieure si l'un des fils en avait.
	INSERT INTO thread_crm_scans (thread_id, identity_id, external_addresses, last_activity_at, scanned_at)
	SELECT p_target, identity_id, max(external_addresses), max(last_activity_at), now()
	FROM thread_crm_scans
	WHERE thread_id = ANY (v_sources)
	GROUP BY identity_id
	ON CONFLICT (thread_id, identity_id) DO UPDATE SET
		external_addresses = greatest(thread_crm_scans.external_addresses, EXCLUDED.external_addresses),
		last_activity_at = greatest(thread_crm_scans.last_activity_at, EXCLUDED.last_activity_at),
		scanned_at = now();
	DELETE FROM thread_crm_scans WHERE thread_id = ANY (v_sources);

	-- Une ligne par dossier contenant un message du fil, comme upsertMailboxThreadItem
	-- (packages/common/src/mail.ts) : le plus recent donne sujet et extrait.
	WITH agg AS (
		SELECT m.mailbox_id,
			count(*) AS cnt,
			count(*) FILTER (WHERE NOT m.seen) AS unread,
			bool_or(m.has_attachments) AS att,
			bool_or(m.flagged) AS star,
			max(coalesce(m.date, m.created_at)) AS last_at,
			min(coalesce(m.date, m.created_at)) AS first_at,
			(array_agg(m.subject ORDER BY coalesce(m.date, m.created_at) DESC))[1] AS subj,
			(array_agg(m.snippet ORDER BY coalesce(m.date, m.created_at) DESC))[1] AS snip
		FROM messages m
		WHERE m.thread_id = p_target AND m.owner_id = v_owner
		GROUP BY m.mailbox_id
	), old AS (
		SELECT mailbox_id,
			max(snoozed_until) AS snoozed_until,
			max(unsnoozed_at) AS unsnoozed_at,
			min(created_at) AS created_at,
			(array_agg(participants ORDER BY last_activity_at DESC) FILTER (WHERE participants IS NOT NULL))[1] AS participants
		FROM mailbox_threads
		WHERE thread_id = p_target OR thread_id = ANY (v_sources)
		GROUP BY mailbox_id
	)
	INSERT INTO mailbox_threads (thread_id, mailbox_id, owner_id, identity_id, identity_public_id,
		mailbox_slug, subject, preview_text, last_activity_at, first_message_at, message_count,
		unread_count, has_attachments, starred, participants, snoozed_until, unsnoozed_at,
		workspace_id, created_at, updated_at)
	SELECT p_target, a.mailbox_id, mb.owner_id, mb.identity_id, i.public_id,
		mb.slug, coalesce(nullif(btrim(a.subj), ''), '(no subject)'), a.snip, a.last_at, a.first_at, a.cnt,
		a.unread, a.att, a.star, o.participants, o.snoozed_until, o.unsnoozed_at,
		mb.workspace_id, coalesce(o.created_at, now()), now()
	FROM agg a
	JOIN mailboxes mb ON mb.id = a.mailbox_id
	JOIN identities i ON i.id = mb.identity_id
	LEFT JOIN old o ON o.mailbox_id = a.mailbox_id
	ON CONFLICT (thread_id, mailbox_id) DO UPDATE SET
		subject = EXCLUDED.subject,
		preview_text = EXCLUDED.preview_text,
		last_activity_at = EXCLUDED.last_activity_at,
		first_message_at = EXCLUDED.first_message_at,
		message_count = EXCLUDED.message_count,
		unread_count = EXCLUDED.unread_count,
		has_attachments = EXCLUDED.has_attachments,
		starred = EXCLUDED.starred,
		participants = coalesce(EXCLUDED.participants, mailbox_threads.participants),
		snoozed_until = EXCLUDED.snoozed_until,
		unsnoozed_at = EXCLUDED.unsnoozed_at,
		identity_id = EXCLUDED.identity_id,
		identity_public_id = EXCLUDED.identity_public_id,
		mailbox_slug = EXCLUDED.mailbox_slug,
		updated_at = now();
	DELETE FROM mailbox_threads WHERE thread_id = ANY (v_sources);

	UPDATE threads t SET
		last_message_date = (SELECT max(coalesce(m.date, m.created_at)) FROM messages m WHERE m.thread_id = p_target),
		updated_at = now()
	WHERE t.id = p_target;

	DELETE FROM threads t
	WHERE t.id = ANY (v_sources)
		AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id);

	RETURN v_moved;
END;
$$;
