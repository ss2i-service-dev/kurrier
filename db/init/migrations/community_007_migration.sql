-- No more DEFAULT 'null'::jsonb on the meta columns. Since migration 002, any insert that omits
-- meta received the JSON null (jsonb 'null'), not the SQL NULL: for instance the Sent copy that
-- send-mail.ts inserts without metaData. `meta || object` then builds an array and jsonb_set fails
-- ("cannot set path in scalar"), which made the mail:move job fail. The DEFAULT is dropped: an
-- insert without meta gives NULL, which coalesce replaces. The code reads both cases
-- (case when jsonb_typeof(meta) = 'object'). Idempotent. Rows already holding 'null' are left as
-- they are (no UPDATE): the code above handles them.
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
