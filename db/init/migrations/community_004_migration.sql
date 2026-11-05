-- Regrouping of split threads.
-- The parser only looked for a PARENT already in the database (In-Reply-To, References):
-- when a reply arrives before its parent (IMAP catch-up from newest to oldest), it creates
-- its own thread, and nothing attached it when the parent arrived. The worker now also
-- looks for existing messages that cite the new one (children) and merges their threads;
-- the same function is used to repair existing data.
--
-- 1. GIN index on messages.references: the search for children (references @> {Message-ID})
--    scanned the whole table (700 ms per incoming message). CONCURRENTLY: no write lock
--    on messages during the build; this file therefore does not open a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ix_messages_references_gin" ON "messages" USING gin ("references");

-- 2. merge_threads(target, sources): moves the messages and labels of the source threads
--    into the target thread, recomputes the target's mailbox_threads rows (counters from
--    the messages, snooze and participants taken from the old rows), then deletes the
--    source threads that became empty. A source thread that would still contain a message
--    is never deleted (messages.thread_id is ON DELETE CASCADE). Returns the number of
--    messages moved, -1 if the target no longer exists (merged in the meantime: rerun the
--    repair). Refuses to merge threads of different owners. The threads rows are locked
--    (FOR UPDATE): a concurrent insert into a source thread waits for the merge to finish.
CREATE OR REPLACE FUNCTION public.merge_threads(p_target uuid, p_sources uuid[])
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
		RAISE EXCEPTION 'merge_threads: threads of different owners (target %)', p_target;
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

	-- One row per folder containing a message of the thread, like upsertMailboxThreadItem
	-- (packages/common/src/mail.ts): the most recent one gives subject and snippet.
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
