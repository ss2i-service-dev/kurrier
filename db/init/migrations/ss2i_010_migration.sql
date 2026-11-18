-- ss2i : plus de DEFAULT 'null'::jsonb sur les colonnes meta (job mail:move 8355 du 13/11 en
-- echec). Depuis la migration 002, toute insertion qui omet meta recevait le JSON null (jsonb
-- 'null'), pas le NULL SQL : 188 messages envoyes (copie Envoyes de send-mail.ts), 2 781 contacts,
-- 15 providers, 3 labels le 18/11. `meta || objet` fabrique alors un tableau et jsonb_set echoue
-- (« cannot set path in scalar »). Le DEFAULT est retire : une insertion sans meta donne NULL, que
-- coalesce remplace. Les lignes deja a 'null' sont reprises a la main (sauvegarde puis update), le
-- code relit les deux cas (case when jsonb_typeof(meta) = 'object'). Idempotent, sans rattrapage.
ALTER TABLE api_keys ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE auth_providers ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE calendar_event_attendees ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE contacts ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE drive_entries ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE drive_volumes ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE identities ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE labels ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE mailboxes ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE messages ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE providers ALTER COLUMN meta DROP DEFAULT;
ALTER TABLE webhooks ALTER COLUMN meta DROP DEFAULT;
