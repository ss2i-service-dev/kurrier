-- ss2i : regroupement des fils eclates.
-- Le parseur ne cherchait qu'un PARENT deja en base (In-Reply-To, References) : quand une
-- reponse arrive avant son parent (rattrapage IMAP du plus recent au plus ancien), elle cree son
-- fil, et rien ne la rattachait quand le parent arrivait. Le worker cherche desormais aussi les
-- messages deja presents qui citent le nouveau (enfants) et fusionne leurs fils ; la meme
-- fonction sert a la reparation de l'existant.
--
-- 1. Index GIN sur messages.references : la recherche des enfants (references @> {Message-ID})
--    parcourait toute la table (700 ms par message entrant). CONCURRENTLY : pas de verrou
--    d'ecriture sur messages pendant la construction ; ce fichier n'ouvre donc pas de transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_messages_references_gin" ON "messages" USING gin ("references");

-- 2. ss2i_merge_threads(cible, sources) : deplace dans le fil cible les messages, libelles et
--    clients des fils sources, recalcule les lignes mailbox_threads de la cible (compteurs depuis
--    les messages, snooze et participants repris des anciennes lignes), puis supprime les fils
--    sources devenus vides. Un fil source qui contiendrait encore un message n'est jamais supprime
--    (messages.thread_id est en ON DELETE CASCADE). Renvoie le nombre de messages deplaces, -1 si
--    la cible n'existe plus (fusionnee entre-temps : relancer la reparation). Refuse de fusionner
--    des fils de proprietaires differents. Les lignes threads sont verrouillees (FOR UPDATE) :
--    une insertion concurrente dans un fil source attend la fin de la fusion.
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

	-- Un rattachement detache a la main le reste apres la fusion.
	INSERT INTO thread_clients (thread_id, identity_id, crm_company_id, owner_id, workspace_id,
		identity_public_id, matched_by, last_activity_at, detached, created_at, updated_at)
	SELECT p_target, identity_id, crm_company_id, min(owner_id::text)::uuid, min(workspace_id::text)::uuid,
		min(identity_public_id), min(matched_by), max(last_activity_at), bool_or(detached), min(created_at), now()
	FROM thread_clients
	WHERE thread_id = ANY (v_sources)
	GROUP BY identity_id, crm_company_id
	ON CONFLICT (thread_id, identity_id, crm_company_id) DO UPDATE SET
		last_activity_at = greatest(thread_clients.last_activity_at, EXCLUDED.last_activity_at),
		detached = thread_clients.detached OR EXCLUDED.detached,
		updated_at = now();
	DELETE FROM thread_clients WHERE thread_id = ANY (v_sources);

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
