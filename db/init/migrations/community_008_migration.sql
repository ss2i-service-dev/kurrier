-- Outbox: draft_messages becomes the send ledger, one row per send (undo delay, scheduled,
-- direct sends through the API and other paths), whatever the path. status keeps its enum
-- (sent = accepted by the SMTP server); delivery_state carries what follows (remote queue, not
-- tracked yet), values checked by the code (packages/common/src/outbox-state.ts), no CHECK.
--  - message_id: Message-ID set before SMTP (correlation, recovery after a crash);
--  - accepted_at, smtp_response, rendered: acceptance by the server and the body frozen at
--    that moment, finalizing (Sent copy) can be replayed from the row;
--  - acceptance_unknown: failure where it is unknown whether the message left ("interrupted");
--  - sent_row_id: messages row created by finalizing (no FK: the copy can be deleted from Sent
--    without touching the ledger);
--  - dismissed_at: failure dismissed from the Outbox by the user.
-- Idempotent: columns and indexes IF NOT EXISTS; the final UPDATEs only touch rows from before
-- the ledger (message_id NULL), replayed they do not touch a recent send. A send left "sending"
-- by the previous worker becomes an interrupted failure (may have been sent), dismissed: the
-- sweep does not wake it up (it only takes rows with a message_id).
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'scheduled';
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS message_id text;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS acceptance_unknown boolean NOT NULL DEFAULT false;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS smtp_response text;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS delivery_state text NOT NULL DEFAULT 'none';
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS queue_ref text;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS last_error text;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS delivery_checked_at timestamptz;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS rendered jsonb;
ALTER TABLE public.draft_messages ADD COLUMN IF NOT EXISTS sent_row_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_draft_messages_identity_message_id
	ON public.draft_messages (identity_id, message_id)
	WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_draft_messages_identity_state
	ON public.draft_messages (identity_id, status, delivery_state);

UPDATE public.draft_messages
SET status = 'failed', acceptance_unknown = true, dismissed_at = now(), updated_at = now()
WHERE status = 'sending'
	AND message_id IS NULL;

UPDATE public.draft_messages
SET dismissed_at = now()
WHERE status = 'failed'
	AND message_id IS NULL
	AND dismissed_at IS NULL;
