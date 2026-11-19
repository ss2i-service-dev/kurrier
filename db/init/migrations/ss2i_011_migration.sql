-- ss2i : archiver avec une duree de vie (docs/plans/archive-duree-de-vie.md). expires_at porte
-- l'echeance sur la ligne du fil dans le dossier archive, a cote de snoozed_until : une ligne
-- supprimee puis recreee (resync, EXPUNGE, fusion) la perd, le fil est conserve (sens sur). Le
-- trigger annule l'echeance de tout fil etoile, quel que soit le chemin d'ecriture de starred.
-- Idempotent.
ALTER TABLE public.mailbox_threads ADD COLUMN IF NOT EXISTS expires_at timestamptz;
CREATE INDEX IF NOT EXISTS ix_mbth_expires_at ON public.mailbox_threads (expires_at) WHERE expires_at IS NOT NULL;
CREATE OR REPLACE FUNCTION public.ss2i_mbth_expiry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.expires_at := NULL; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS ss2i_mbth_expiry_guard ON public.mailbox_threads;
CREATE TRIGGER ss2i_mbth_expiry_guard BEFORE INSERT OR UPDATE ON public.mailbox_threads
FOR EACH ROW WHEN (NEW.starred AND NEW.expires_at IS NOT NULL) EXECUTE FUNCTION public.ss2i_mbth_expiry_guard();
