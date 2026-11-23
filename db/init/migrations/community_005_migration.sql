-- has_attachments no longer counts images embedded in the body: nearly every mail with an
-- image signature was shown with an attachment.
-- The worker computed has_attachments over all the MIME parts returned by mailparser,
-- signature images included; it now applies hasRealAttachments (packages/common/src/
-- real-attachments.ts). This catches up the existing data with the same rule: an image
-- referenced by cid or inline is not an attachment, any other file is one (a PDF with a cid
-- included).
-- A message without any message_attachments row keeps its flag (nothing to judge it by).
-- Threads follow (same aggregate as merge_threads: bool_or per thread and per folder).
-- Idempotent: replayed, it changes nothing.
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
