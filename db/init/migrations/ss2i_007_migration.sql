-- ss2i : has_attachments ne compte plus les images integrees au corps (Samuel le 10/11 : « tous
-- les mails ont des pieces jointes quasiment des qu'il y a une signature image dedans »).
-- Le worker calculait has_attachments sur toutes les parties MIME de mailparser, images de
-- signature comprises ; il applique desormais hasRealAttachments (packages/common/src/
-- real-attachments.ts). Ici, rattrapage de l'existant avec la meme regle : une image en cid ou
-- inline n'est pas une piece jointe, tout autre fichier en est une (PDF avec cid compris).
-- Un message sans aucune ligne message_attachments garde son drapeau (rien pour en juger).
-- Les fils suivent (meme agregat que ss2i_merge_threads : bool_or par fil et par dossier).
-- Idempotent : rejouee, elle ne change plus rien.
UPDATE messages m
SET has_attachments = false
WHERE m.has_attachments
  AND EXISTS (SELECT 1 FROM message_attachments a WHERE a.message_id = m.id)
  AND NOT EXISTS (
	SELECT 1 FROM message_attachments a
	WHERE a.message_id = m.id
	  AND not (coalesce(a.content_type, '') ilike 'image/%' and (a.is_inline or a.cid is not null))
  );

UPDATE mailbox_threads mt
SET has_attachments = false
WHERE mt.has_attachments
  AND NOT EXISTS (
	SELECT 1 FROM messages m
	WHERE m.thread_id = mt.thread_id AND m.mailbox_id = mt.mailbox_id AND m.has_attachments
  );
