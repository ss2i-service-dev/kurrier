-- ss2i : suggestions de destinataires de l'editeur classees par usage reel.
-- Tables agregees par utilisateur (owner_id), alimentees par le worker a chaque envoi
-- depuis courrier et a chaque message synchronise dans un dossier Envoyes, rattrapees
-- ici sur l'historique. Jamais lues ailleurs que par l'editeur (suggestions).
--
-- Score « frecency » : somme, sur les envois a l'adresse, de 0,5 ^ (age / 30 jours),
-- l'age etant compte depuis le dernier envoi (last_used_at). Le score stocke vaut donc
-- pour last_used_at ; a la lecture, ss2i_decay(score, last_used_at, now()) le ramene a
-- maintenant. La formule est independante de l'ordre d'ingestion : un message plus
-- ancien que le dernier connu ajoute 0,5 ^ (ecart / 30 j) sans deplacer last_used_at.
-- Paires : meme formule, sur la co-occurrence de deux adresses dans un meme envoi
-- (stockee dans les deux sens), limitee aux envois de 2 a 10 destinataires.
CREATE TABLE "ss2i_recipient_stats" (
	"owner_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"count" integer DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ss2i_recipient_stats_pkey" PRIMARY KEY ("owner_id", "email")
);
--> statement-breakpoint
ALTER TABLE "ss2i_recipient_stats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ss2i_recipient_pairs" (
	"owner_id" uuid NOT NULL,
	"email" text NOT NULL,
	"other" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ss2i_recipient_pairs_pkey" PRIMARY KEY ("owner_id", "email", "other")
);
--> statement-breakpoint
ALTER TABLE "ss2i_recipient_pairs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Garde d'idempotence : un message (Message-ID) ne compte qu'une fois par utilisateur.
CREATE TABLE "ss2i_recipient_ingested" (
	"owner_id" uuid NOT NULL,
	"message_id" text NOT NULL,
	CONSTRAINT "ss2i_recipient_ingested_pkey" PRIMARY KEY ("owner_id", "message_id")
);
--> statement-breakpoint
ALTER TABLE "ss2i_recipient_ingested" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ss2i_recipient_stats" ADD CONSTRAINT "ss2i_recipient_stats_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ss2i_recipient_pairs" ADD CONSTRAINT "ss2i_recipient_pairs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ss2i_recipient_ingested" ADD CONSTRAINT "ss2i_recipient_ingested_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "auth"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "ss2i_recipient_stats_select_owner" ON "ss2i_recipient_stats" AS PERMISSIVE FOR SELECT TO "kurrier" USING ("ss2i_recipient_stats"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "ss2i_recipient_pairs_select_owner" ON "ss2i_recipient_pairs" AS PERMISSIVE FOR SELECT TO "kurrier" USING ("ss2i_recipient_pairs"."owner_id" = nullif(current_setting('request.jwt.claim.sub', true), '')::uuid);--> statement-breakpoint
-- Decroissance : score vu a from_ts, ramene a to_ts (demi-vie 30 jours).
CREATE OR REPLACE FUNCTION ss2i_decay(p_score double precision, p_from timestamptz, p_to timestamptz)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
	SELECT p_score * power(0.5, extract(epoch FROM (p_to - p_from)) / (30.0 * 86400.0));
$$;
--> statement-breakpoint
-- Tableau « value » d'un champ d'adresses jsonb de messages (mailparser), sinon vide.
CREATE OR REPLACE FUNCTION ss2i_addr_values(p_field jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE WHEN jsonb_typeof(p_field -> 'value') = 'array' THEN p_field -> 'value' ELSE '[]'::jsonb END;
$$;
--> statement-breakpoint
-- Ingestion d'un envoi : p_recipients = [{"address": ..., "name": ...}, ...] (To, Cc, Bcc,
-- deja prive des adresses de l'expediteur). Rend false si le message etait deja compte.
CREATE OR REPLACE FUNCTION ss2i_recipient_ingest(p_owner uuid, p_message_id text, p_sent_at timestamptz, p_recipients jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
	v_inserted integer;
	v_n integer;
	v_r jsonb;
BEGIN
	INSERT INTO ss2i_recipient_ingested (owner_id, message_id) VALUES (p_owner, p_message_id)
	ON CONFLICT DO NOTHING;
	GET DIAGNOSTICS v_inserted = ROW_COUNT;
	IF v_inserted = 0 THEN
		RETURN false;
	END IF;

	-- Destinataires normalises (minuscules, dedoublonnes, nom non vide prefere).
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

	INSERT INTO ss2i_recipient_stats (owner_id, email, name, count, score, last_used_at)
	SELECT p_owner, r.email, r.name, 1, 1, p_sent_at FROM jsonb_to_recordset(v_r) AS r(email text, name text)
	ON CONFLICT (owner_id, email) DO UPDATE SET
		count = ss2i_recipient_stats.count + 1,
		score = ss2i_decay(ss2i_recipient_stats.score, ss2i_recipient_stats.last_used_at, greatest(ss2i_recipient_stats.last_used_at, excluded.last_used_at))
			+ ss2i_decay(1, excluded.last_used_at, greatest(ss2i_recipient_stats.last_used_at, excluded.last_used_at)),
		name = CASE
			WHEN excluded.last_used_at >= ss2i_recipient_stats.last_used_at AND excluded.name IS NOT NULL THEN excluded.name
			ELSE coalesce(ss2i_recipient_stats.name, excluded.name)
		END,
		last_used_at = greatest(ss2i_recipient_stats.last_used_at, excluded.last_used_at);

	v_n := jsonb_array_length(v_r);
	IF v_n BETWEEN 2 AND 10 THEN
		INSERT INTO ss2i_recipient_pairs (owner_id, email, other, count, score, last_used_at)
		SELECT p_owner, a.email, b.email, 1, 1, p_sent_at
		FROM jsonb_to_recordset(v_r) AS a(email text, name text)
		JOIN jsonb_to_recordset(v_r) AS b(email text, name text) ON a.email <> b.email
		ON CONFLICT (owner_id, email, other) DO UPDATE SET
			count = ss2i_recipient_pairs.count + 1,
			score = ss2i_decay(ss2i_recipient_pairs.score, ss2i_recipient_pairs.last_used_at, greatest(ss2i_recipient_pairs.last_used_at, excluded.last_used_at))
				+ ss2i_decay(1, excluded.last_used_at, greatest(ss2i_recipient_pairs.last_used_at, excluded.last_used_at)),
			last_used_at = greatest(ss2i_recipient_pairs.last_used_at, excluded.last_used_at);
	END IF;
	RETURN true;
END;
$$;
--> statement-breakpoint
-- Rattrapage sur l'historique : tous les messages des dossiers Envoyes, par proprietaire
-- de la ligne, sans l'adresse de l'identite du dossier. Meme formule que la fonction
-- (somme des 0,5 ^ (ecart au dernier envoi / 30 j)), calculee d'un bloc.
CREATE TEMP TABLE ss2i_backfill_r AS
WITH sent AS (
	SELECT m.owner_id, m.message_id, coalesce(m.date, m.created_at) AS sent_at,
		lower(trim(i.value)) AS own, m."to", m.cc, m.bcc
	FROM messages m
	JOIN mailboxes mb ON mb.id = m.mailbox_id
	LEFT JOIN identities i ON i.id = mb.identity_id
	WHERE mb.kind = 'sent' AND m.message_id IS NOT NULL
),
ins AS (
	INSERT INTO ss2i_recipient_ingested (owner_id, message_id)
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
	FROM jsonb_array_elements(ss2i_addr_values(o."to") || ss2i_addr_values(o.cc) || ss2i_addr_values(o.bcc)) x
) e
WHERE e.email LIKE '%@%' AND (o.own IS NULL OR e.email <> o.own)
ORDER BY o.owner_id, o.message_id, e.email, e.name NULLS LAST;
--> statement-breakpoint
INSERT INTO ss2i_recipient_stats (owner_id, email, name, count, score, last_used_at)
SELECT owner_id, email,
	(array_agg(name ORDER BY sent_at DESC) FILTER (WHERE name IS NOT NULL))[1],
	count(*),
	sum(ss2i_decay(1, sent_at, last_at)),
	max(sent_at)
FROM (
	SELECT r.*, max(sent_at) OVER (PARTITION BY owner_id, email) AS last_at FROM ss2i_backfill_r r
) s
GROUP BY owner_id, email
ON CONFLICT (owner_id, email) DO UPDATE SET
	count = ss2i_recipient_stats.count + excluded.count,
	score = ss2i_decay(ss2i_recipient_stats.score, ss2i_recipient_stats.last_used_at, greatest(ss2i_recipient_stats.last_used_at, excluded.last_used_at))
		+ ss2i_decay(excluded.score, excluded.last_used_at, greatest(ss2i_recipient_stats.last_used_at, excluded.last_used_at)),
	name = CASE
		WHEN excluded.last_used_at >= ss2i_recipient_stats.last_used_at AND excluded.name IS NOT NULL THEN excluded.name
		ELSE coalesce(ss2i_recipient_stats.name, excluded.name)
	END,
	last_used_at = greatest(ss2i_recipient_stats.last_used_at, excluded.last_used_at);
--> statement-breakpoint
INSERT INTO ss2i_recipient_pairs (owner_id, email, other, count, score, last_used_at)
SELECT owner_id, email, other, count(*), sum(ss2i_decay(1, sent_at, last_at)), max(sent_at)
FROM (
	SELECT a.owner_id, a.email, b.email AS other, a.sent_at,
		max(a.sent_at) OVER (PARTITION BY a.owner_id, a.email, b.email) AS last_at
	FROM ss2i_backfill_r a
	JOIN ss2i_backfill_r b ON b.owner_id = a.owner_id AND b.message_id = a.message_id AND b.email <> a.email
	JOIN (
		SELECT owner_id, message_id FROM ss2i_backfill_r GROUP BY owner_id, message_id HAVING count(*) BETWEEN 2 AND 10
	) n ON n.owner_id = a.owner_id AND n.message_id = a.message_id
) p
GROUP BY owner_id, email, other
ON CONFLICT (owner_id, email, other) DO UPDATE SET
	count = ss2i_recipient_pairs.count + excluded.count,
	score = ss2i_decay(ss2i_recipient_pairs.score, ss2i_recipient_pairs.last_used_at, greatest(ss2i_recipient_pairs.last_used_at, excluded.last_used_at))
		+ ss2i_decay(excluded.score, excluded.last_used_at, greatest(ss2i_recipient_pairs.last_used_at, excluded.last_used_at)),
	last_used_at = greatest(ss2i_recipient_pairs.last_used_at, excluded.last_used_at);
--> statement-breakpoint
DROP TABLE ss2i_backfill_r;
