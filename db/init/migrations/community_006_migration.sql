-- Blank sender in the thread list. Two causes, fixed in packages/common/src/mail.ts:
--  - messages sent from kurrier store `from` as a plain string ("a@b" or "\"Name\" <a@b>");
--    the thread summary only read the mailparser object (`value`);
--  - a row with NULL participants (folder of the incoming message, after merge_threads)
--    stayed NULL: NULL || x = NULL in the upsert.
-- This catches up the affected rows (NULL participants, or no sender) with the same rule as
-- upsertMailboxThreadItem: messages of the thread in this folder, newest to oldest, at most
-- 5 distinct addresses (case-insensitive) per category.
-- Idempotent: replayed, it only recomputes the rows that still have no sender.
WITH targets AS (
	SELECT mt.thread_id, mt.mailbox_id
	FROM mailbox_threads mt
	WHERE mt.participants IS NULL
	   OR jsonb_array_length(coalesce(mt.participants->'from', '[]'::jsonb)) = 0
), fields AS (
	SELECT t.thread_id, t.mailbox_id, coalesce(m.date, m.created_at) AS at, m.id AS message_id,
		k.bucket, k.field
	FROM targets t
	JOIN messages m ON m.thread_id = t.thread_id AND m.mailbox_id = t.mailbox_id
	CROSS JOIN LATERAL (VALUES ('from', m."from"), ('to', m."to"), ('cc', m.cc), ('bcc', m.bcc)) k(bucket, field)
	WHERE k.field IS NOT NULL
), addrs AS (
	-- mailparser object: { value: [{ name, address }] }
	SELECT f.thread_id, f.mailbox_id, f.bucket, f.at, f.message_id, v.ord,
		nullif(v.x->>'name', '') AS n, nullif(btrim(v.x->>'address'), '') AS e
	FROM fields f
	CROSS JOIN LATERAL jsonb_array_elements(f.field->'value') WITH ORDINALITY v(x, ord)
	WHERE jsonb_typeof(f.field) = 'object' AND jsonb_typeof(f.field->'value') = 'array'
	UNION ALL
	-- plain string: "a@b, \"Name\" <c@d>" (a comma inside a quoted name is respected)
	SELECT f.thread_id, f.mailbox_id, f.bucket, f.at, f.message_id, p.ord,
		nullif(btrim(substring(btrim(p.part[1]) from '^"?([^"<]*?)"?\s*<')), '') AS n,
		CASE
			WHEN btrim(p.part[1]) ~ '<[^>]+>\s*$' THEN nullif(btrim(substring(p.part[1] from '<([^>]+)>\s*$')), '')
			WHEN position('@' in p.part[1]) > 0 THEN btrim(p.part[1])
		END AS e
	FROM fields f
	CROSS JOIN LATERAL regexp_matches(f.field #>> '{}', '(?:"[^"]*"|[^,])+', 'g') WITH ORDINALITY p(part, ord)
	WHERE jsonb_typeof(f.field) = 'string'
), firsts AS (
	SELECT DISTINCT ON (thread_id, mailbox_id, bucket, lower(e))
		thread_id, mailbox_id, bucket, n, e, at, message_id, ord
	FROM addrs
	WHERE e IS NOT NULL
	ORDER BY thread_id, mailbox_id, bucket, lower(e), at DESC, message_id, ord
), ranked AS (
	SELECT *, row_number() OVER (PARTITION BY thread_id, mailbox_id, bucket ORDER BY at DESC, message_id, ord) AS rn
	FROM firsts
), buckets AS (
	SELECT thread_id, mailbox_id, bucket,
		jsonb_agg(jsonb_build_object('n', n, 'e', e) ORDER BY rn) AS list
	FROM ranked
	WHERE rn <= 5
	GROUP BY thread_id, mailbox_id, bucket
), snap AS (
	SELECT t.thread_id, t.mailbox_id, jsonb_build_object(
		'from', coalesce((SELECT list FROM buckets b WHERE b.thread_id = t.thread_id AND b.mailbox_id = t.mailbox_id AND b.bucket = 'from'), '[]'::jsonb),
		'to', coalesce((SELECT list FROM buckets b WHERE b.thread_id = t.thread_id AND b.mailbox_id = t.mailbox_id AND b.bucket = 'to'), '[]'::jsonb),
		'cc', coalesce((SELECT list FROM buckets b WHERE b.thread_id = t.thread_id AND b.mailbox_id = t.mailbox_id AND b.bucket = 'cc'), '[]'::jsonb),
		'bcc', coalesce((SELECT list FROM buckets b WHERE b.thread_id = t.thread_id AND b.mailbox_id = t.mailbox_id AND b.bucket = 'bcc'), '[]'::jsonb)
	) AS participants
	FROM targets t
	WHERE EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.thread_id AND m.mailbox_id = t.mailbox_id)
)
UPDATE mailbox_threads mt
SET participants = s.participants, updated_at = now()
FROM snap s
WHERE mt.thread_id = s.thread_id AND mt.mailbox_id = s.mailbox_id
  AND mt.participants IS DISTINCT FROM s.participants;
