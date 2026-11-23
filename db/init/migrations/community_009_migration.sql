-- Archive for a chosen duration. expires_at carries the expiry on the thread row of the archive
-- folder, next to snoozed_until: a row deleted then recreated (resync, EXPUNGE, merge) loses it,
-- the thread is kept (safe side). The trigger clears the expiry of any starred thread, whatever
-- path writes starred.
-- Idempotent.
SET lock_timeout = '5s';
ALTER TABLE public.mailbox_threads ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS ix_mbth_expires_at ON public.mailbox_threads (expires_at) WHERE expires_at IS NOT NULL;
CREATE OR REPLACE FUNCTION public.mbth_expiry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.expires_at := NULL; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS mbth_expiry_guard ON public.mailbox_threads;
CREATE TRIGGER mbth_expiry_guard BEFORE INSERT OR UPDATE ON public.mailbox_threads
FOR EACH ROW WHEN (NEW.starred AND NEW.expires_at IS NOT NULL) EXECUTE FUNCTION public.mbth_expiry_guard();
