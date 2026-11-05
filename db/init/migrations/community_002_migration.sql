-- Editor recipient suggestions ranked by real usage.
-- Tables aggregated per user (owner_id), fed by the worker on every send from the app
-- and on every message synced into a Sent folder, and backfilled here from the history.
-- Only read by the editor (suggestions).
--
-- "Frecency" score: sum, over the sends to the address, of 0.5 ^ (age / 30 days), the
-- age being counted from the last send (last_used_at). The stored score is therefore
-- valid at last_used_at; on read, recipient_decay(score, last_used_at, now()) brings it
-- to now. The formula does not depend on the ingestion order: a message older than the
-- last known one adds 0.5 ^ (gap / 30 d) without moving last_used_at.
-- Pairs: same formula, on the co-occurrence of two addresses in the same send (stored
-- in both directions), limited to sends with 2 to 10 recipients.
CREATE TABLE "recipient_stats" (
	"owner_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"count" integer DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recipient_stats_pkey" PRIMARY KEY ("owner_id", "email")
);
--> statement-breakpoint
ALTER TABLE "recipient_stats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recipient_pairs" (
	"owner_id" uuid NOT NULL,
	"email" text NOT NULL,
	"other" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recipient_pairs_pkey" PRIMARY KEY ("owner_id", "email", "other")
);
--> statement-breakpoint
ALTER TABLE "recipient_pairs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Idempotence guard: a message (Message-ID) counts only once per user.
CREATE TABLE "recipient_ingested" (
	"owner_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	CONSTRAINT "recipient_ingested_pkey" PRIMARY KEY ("owner_id", "message_id")
);
--> statement-breakpoint
ALTER TABLE "recipient_ingested" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recipient_stats" ADD CONSTRAINT "recipient_stats_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_pairs" ADD CONSTRAINT "recipient_pairs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recipient_ingested" ADD CONSTRAINT "recipient_ingested_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "recipient_stats_select_owner" ON "recipient_stats" AS PERMISSIVE FOR SELECT TO "kurrier" USING ("recipient_stats"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "recipient_pairs_select_owner" ON "recipient_pairs" AS PERMISSIVE FOR SELECT TO "kurrier" USING ("recipient_pairs"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);--> statement-breakpoint
-- Decay: score seen at from_ts, brought to to_ts (30-day half-life).
CREATE OR REPLACE FUNCTION recipient_decay(p_score double precision, p_from timestamptz, p_to timestamptz)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
	SELECT p_score * power(0.5, extract(epoch FROM (p_to - p_from)) / (30.0 * 86400.0));
$$;
--> statement-breakpoint
-- "value" array of a messages jsonb address field (mailparser), otherwise empty.
CREATE OR REPLACE FUNCTION recipient_addr_values(p_field jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE WHEN jsonb_typeof(p_field -> 'value') = 'array' THEN p_field -> 'value' ELSE '[]'::jsonb END;
$$;
--> statement-breakpoint
-- Ingest one send: p_recipients = [{"address": ..., "name": ...}, ...] (To, Cc, Bcc,
-- already stripped of the sender's addresses). Returns false if the message was already counted.
CREATE OR REPLACE FUNCTION recipient_ingest(p_owner uuid, p_message_id text, p_sent_at timestamptz, p_recipients jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
	v_inserted integer;
	v_n integer;
	v_r jsonb;
BEGIN
	INSERT INTO recipient_ingested (owner_id, message_id) VALUES (p_owner, p_message_id)
	ON CONFLICT DO NOTHING;
	GET DIAGNOSTICS v_inserted = ROW_COUNT;
	IF v_inserted = 0 THEN
		RETURN false;
	END IF;

	-- Normalized recipients (lowercase, deduplicated, non-empty name preferred).
	SELECT coalesce(jsonb_agg(jsonb_build_object('email', email, 'name', name)), '[]'::jsonb) INTO v_r
	FROM (
		SELECT DISTINCT ON (email) email, name
		FROM (
			SELECT lower(trim(x ->> 'address')) AS email, nullif(trim(x ->> 'name'), '') AS name
			FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_recipients) = 'array' THEN p_recipients ELSE '[]'::jsonb END) x
		) s
		WHERE email LIKE '%@%'
		ORDER BY email, name NULLS LAST
	) d;

	INSERT INTO recipient_stats (owner_id, email, name, count, score, last_used_at)
	SELECT p_owner, r.email, r.name, 1, 1, p_sent_at FROM jsonb_to_recordset(v_r) AS r(email text, name text)
	ON CONFLICT (owner_id, email) DO UPDATE SET
		count = recipient_stats.count + 1,
		score = recipient_decay(recipient_stats.score, recipient_stats.last_used_at, greatest(recipient_stats.last_used_at, excluded.last_used_at))
			+ recipient_decay(1, excluded.last_used_at, greatest(recipient_stats.last_used_at, excluded.last_used_at)),
		name = CASE
			WHEN excluded.last_used_at >= recipient_stats.last_used_at AND excluded.name IS NOT NULL THEN excluded.name
			ELSE coalesce(recipient_stats.name, excluded.name)
		END,
		last_used_at = greatest(recipient_stats.last_used_at, excluded.last_used_at);

	v_n := jsonb_array_length(v_r);
	IF v_n BETWEEN 2 AND 10 THEN
		INSERT INTO recipient_pairs (owner_id, email, other, count, score, last_used_at)
		SELECT p_owner, a.email, b.email, 1, 1, p_sent_at
		FROM jsonb_to_recordset(v_r) AS a(email text, name text)
		JOIN jsonb_to_recordset(v_r) AS b(email text, name text) ON a.email <> b.email
		ON CONFLICT (owner_id, email, other) DO UPDATE SET
			count = recipient_pairs.count + 1,
			score = recipient_decay(recipient_pairs.score, recipient_pairs.last_used_at, greatest(recipient_pairs.last_used_at, excluded.last_used_at))
				+ recipient_decay(1, excluded.last_used_at, greatest(recipient_pairs.last_used_at, excluded.last_used_at)),
			last_used_at = greatest(recipient_pairs.last_used_at, excluded.last_used_at);
	END IF;
	RETURN true;
END;
$$;
--> statement-breakpoint
-- Backfill from the history: all messages of the Sent folders, per row owner, without
-- the address of the folder's identity. Same formula as the function (sum of
-- 0.5 ^ (gap to the last send / 30 d)), computed in one pass.
CREATE TEMP TABLE recipient_backfill_tmp AS
WITH sent AS (
	SELECT m.owner_id, m.message_id, coalesce(m.date, m.created_at) AS sent_at,
		lower(trim(i.value)) AS own, m."to", m.cc, m.bcc
	FROM messages m
	JOIN mailboxes mb ON mb.id = m.mailbox_id
	LEFT JOIN identities i ON i.id = mb.identity_id
	WHERE mb.kind = 'sent' AND m.message_id IS NOT NULL
),
ins AS (
	INSERT INTO recipient_ingested (owner_id, message_id)
	SELECT DISTINCT owner_id, message_id FROM sent
	ON CONFLICT DO NOTHING
	RETURNING owner_id, message_id
),
one AS (
	SELECT DISTINCT ON (s.owner_id, s.message_id) s.*
	FROM sent s JOIN ins ON ins.owner_id = s.owner_id AND ins.message_id = s.message_id
	ORDER BY s.owner_id, s.message_id, s.sent_at DESC
)
SELECT DISTINCT ON (o.owner_id, o.message_id, e.email)
	o.owner_id, o.message_id, o.sent_at, e.email, e.name
FROM one o
CROSS JOIN LATERAL (
	SELECT lower(trim(x ->> 'address')) AS email, nullif(trim(x ->> 'name'), '') AS name
	FROM jsonb_array_elements(recipient_addr_values(o."to") || recipient_addr_values(o.cc) || recipient_addr_values(o.bcc)) x
) e
WHERE e.email LIKE '%@%' AND (o.own IS NULL OR e.email <> o.own)
ORDER BY o.owner_id, o.message_id, e.email, e.name NULLS LAST;
--> statement-breakpoint
INSERT INTO recipient_stats (owner_id, email, name, count, score, last_used_at)
SELECT owner_id, email,
	(array_agg(name ORDER BY sent_at DESC) FILTER (WHERE name IS NOT NULL))[1],
	count(*),
	sum(recipient_decay(1, sent_at, last_at)),
	max(sent_at)
FROM (
	SELECT r.*, max(sent_at) OVER (PARTITION BY owner_id, email) AS last_at FROM recipient_backfill_tmp r
) s
GROUP BY owner_id, email
ON CONFLICT (owner_id, email) DO UPDATE SET
	count = recipient_stats.count + excluded.count,
	score = recipient_decay(recipient_stats.score, recipient_stats.last_used_at, greatest(recipient_stats.last_used_at, excluded.last_used_at))
		+ recipient_decay(excluded.score, excluded.last_used_at, greatest(recipient_stats.last_used_at, excluded.last_used_at)),
	name = CASE
		WHEN excluded.last_used_at >= recipient_stats.last_used_at AND excluded.name IS NOT NULL THEN excluded.name
		ELSE coalesce(recipient_stats.name, excluded.name)
	END,
	last_used_at = greatest(recipient_stats.last_used_at, excluded.last_used_at);
--> statement-breakpoint
INSERT INTO recipient_pairs (owner_id, email, other, count, score, last_used_at)
SELECT owner_id, email, other, count(*), sum(recipient_decay(1, sent_at, last_at)), max(sent_at)
FROM (
	SELECT a.owner_id, a.email, b.email AS other, a.sent_at,
		max(a.sent_at) OVER (PARTITION BY a.owner_id, a.email, b.email) AS last_at
	FROM recipient_backfill_tmp a
	JOIN recipient_backfill_tmp b ON b.owner_id = a.owner_id AND b.message_id = a.message_id AND b.email <> a.email
	JOIN (
		SELECT owner_id, message_id FROM recipient_backfill_tmp GROUP BY owner_id, message_id HAVING count(*) BETWEEN 2 AND 10
	) n ON n.owner_id = a.owner_id AND n.message_id = a.message_id
) p
GROUP BY owner_id, email, other
ON CONFLICT (owner_id, email, other) DO UPDATE SET
	count = recipient_pairs.count + excluded.count,
	score = recipient_decay(recipient_pairs.score, recipient_pairs.last_used_at, greatest(recipient_pairs.last_used_at, excluded.last_used_at))
		+ recipient_decay(excluded.score, excluded.last_used_at, greatest(recipient_pairs.last_used_at, excluded.last_used_at)),
	last_used_at = greatest(recipient_pairs.last_used_at, excluded.last_used_at);
--> statement-breakpoint
DROP TABLE recipient_backfill_tmp;
