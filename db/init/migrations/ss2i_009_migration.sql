-- ss2i : Boite d'envoi (OI 10519, Samuel le 13/11 pendant la panne Microsoft Graph : « les mails
-- en file d'attente qui ne sont pas effectivement partis, il faut me les mettre dans un truc en
-- cours d'envoi »). draft_messages devient le ledger d'envoi : une ligne par envoi (delai
-- d'annulation, programme, MCP, API), quel que soit le chemin. status garde son enum (sent =
-- accepte par le serveur SMTP) ; delivery_state porte la suite (file distante, lot 2), valeurs
-- controlees par le code (packages/common/src/outbox-state.ts), sans CHECK.
--  - message_id : Message-ID fixe par courrier avant le SMTP (correlation, reprise apres crash) ;
--  - accepted_at, smtp_response, rendered : acceptation par le serveur et corps fige a ce moment,
--    la finalisation (copie Envoyes) se rejoue depuis la ligne ;
--  - acceptance_unknown : echec dont on ne sait pas si le message est parti (« interrompu ») ;
--  - sent_row_id : ligne messages creee par la finalisation (sans FK : la copie peut etre
--    supprimee de Envoyes sans toucher au ledger) ;
--  - dismissed_at : echec ecarte de la Boite d'envoi par l'utilisateur.
-- Idempotent : colonnes et index IF NOT EXISTS ; l'UPDATE final n'ecarte que les echecs d'avant
-- le ledger (message_id NULL), rejoue il ne touche pas un echec recent.
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
SET dismissed_at = now()
WHERE status = 'failed'
	AND message_id IS NULL
	AND dismissed_at IS NULL;
