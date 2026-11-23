// Resuming the local copy when the editor opens (lib/draft-backup.ts).
//
// After a forced reload (redeploy), the editor reopens the draft as the server has it: the
// last keystrokes, not saved yet, are no longer on screen, and come back only when
// DraftBackupRecovery sends them to Drafts. What you type never disappears: when the local copy
// is more recent than the server, the editor opens on it.
import type { DraftBackup } from "@/lib/draft-backup";

// Same threshold as DraftBackupRecovery: a live editor beats every second.
export const ALIVE_MS = 10_000;
// Clock skew tolerated between this browser (updatedAt of the copy) and the server (savedAt of
// the draft): below it, the copy is not judged older than the server.
export const CLOCK_SKEW_MS = 60_000;

export type EditorTarget = {
	// Server draft opened in the editor (`draft` prop), if any.
	draftMessageId: string | null;
	// Last server save of that draft, in milliseconds.
	draftUpdatedAt: number | null;
	// Reply to or forward of a message (`message` prop).
	originalMessageId: string | null;
	mode: string | null;
	now: number;
	aliveAt: (id: string) => number;
};

// "replyAll" is only a reply with Cc recipients; the server knows reply / forward / new (the
// form sends "compose").
const modeOf = (m: string | null | undefined) =>
	m === "reply" || m === "replyAll" ? "reply" : m === "forward" ? "forward" : "compose";

// Copy to resume, or null. Never a sent copy, an already saved one, or one whose editor is alive
// (another tab). Draft opened: copy of the same draft, more recent than it. No draft: a reply or
// forward never saved (copy without a server draft), found by original message and mode. Several
// candidates: the most recent.
export function pickBackupForEditor(backups: DraftBackup[], t: EditorTarget): DraftBackup | null {
	let best: DraftBackup | null = null;
	for (const b of backups) {
		if (b.sentAt) continue;
		if (b.key === b.savedKey) continue;
		if (t.now - t.aliveAt(b.id) < ALIVE_MS) continue;
		if (t.draftMessageId) {
			if (b.draftMessageId !== t.draftMessageId) continue;
			if (t.draftUpdatedAt != null && t.draftUpdatedAt > b.updatedAt + CLOCK_SKEW_MS) continue;
		} else {
			if (!t.originalMessageId || b.draftMessageId) continue;
			if ((b.payload.originalMessageId ?? null) !== t.originalMessageId) continue;
			if (modeOf(b.payload.mode) !== modeOf(t.mode)) continue;
		}
		if (!best || b.updatedAt > best.updatedAt) best = b;
	}
	return best;
}

// Same reading as packages/common/src/drafts.ts (parseAddressList), without the server
// dependency: "Name <address>" or "address", separated by commas.
function addressObj(input: string | null | undefined) {
	const value = String(input ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((raw) => {
			const m = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
			return m ? { name: (m[1] ?? "").trim(), address: m[2].trim() } : { name: "", address: raw };
		});
	return { value };
}

function attachmentsOf(input: string | null | undefined): any[] {
	try {
		const a = JSON.parse(String(input ?? "[]"));
		return Array.isArray(a) ? a : [];
	} catch {
		return [];
	}
}

// Draft row (shape of `messages`, read by the header, the body, the footer and the quote of the
// editor) rebuilt from the copy. `base`: the server draft, whose rest (id, metaData.imap,
// revision) is kept; null for a reply never saved.
export function backupToDraftRow(b: DraftBackup, base: Record<string, any> | null) {
	const p = b.payload;
	const baseMeta = (base?.metaData as any) ?? {};
	const draft: Record<string, any> = {
		...(baseMeta.draft ?? {}),
		mode: p.mode === "reply" || p.mode === "forward" ? p.mode : "new",
		originalMessageId: p.originalMessageId || null,
		attachments: attachmentsOf(p.attachments),
		includeSignature: p.includeSignature !== "false",
	};
	// The quote goes into the form only for a reply or forward; absent from the copy (quota), the
	// choice of the server draft stays.
	if (p.quoteScope) draft.quoteScope = p.quoteScope;
	if (p.quoteMode) draft.quoteMode = p.quoteMode;
	if (p.quoteHtml) draft.quoteHtml = p.quoteHtml;
	return {
		...(base ?? {}),
		id: b.draftMessageId ?? base?.id ?? "",
		subject: p.subject ?? "",
		html: p.html ?? "",
		to: addressObj(p.to),
		cc: addressObj(p.cc),
		bcc: addressObj(p.bcc),
		metaData: { ...baseMeta, draft },
	};
}
