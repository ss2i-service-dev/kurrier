// Local copy (localStorage) of each draft being written.
//
// The server save (saveDraft) can fail without the editor really knowing: after a
// redeploy, the open tab calls Server Actions that no longer exist
// ("Failed to find Server Action"), during a restart the proxy returns its error page,
// then a navigation ends in a full reload and the text disappears.
// The local copy depends on no server: it is written on every keystroke and read back on
// the next load (DraftBackupRecovery), which sends it back to Drafts.

export const BACKUP_PREFIX = "kurrier-draft-backup:";
const ALIVE_PREFIX = "kurrier-draft-alive:";

export type DraftBackupPayload = Record<string, string | null>;

export type DraftBackup = {
	v: 1;
	id: string;
	identityPublicId: string;
	draftMessageId: string | null;
	payload: DraftBackupPayload;
	key: string;
	// Key of the last state confirmed by the server: equal to `key`, nothing to recover.
	savedKey: string | null;
	// Set on send, cleared by Undo or a failure: a sent message is not recovered.
	sentAt: number | null;
	updatedAt: number;
};

export function newBackupId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}
}

function storage(): Storage | null {
	try {
		return typeof window === "undefined" ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function readBackup(id: string): DraftBackup | null {
	const s = storage();
	if (!s) return null;
	try {
		const raw = s.getItem(BACKUP_PREFIX + id);
		return raw ? (JSON.parse(raw) as DraftBackup) : null;
	} catch {
		return null;
	}
}

export function writeBackup(b: DraftBackup): boolean {
	const s = storage();
	if (!s) return false;
	try {
		s.setItem(BACKUP_PREFIX + b.id, JSON.stringify(b));
		return true;
	} catch {
		// Quota: the quote (often the biggest part) is sacrificed, the text stays.
		try {
			const slim = { ...b, payload: { ...b.payload, quoteHtml: null } };
			s.setItem(BACKUP_PREFIX + b.id, JSON.stringify(slim));
			return true;
		} catch {
			return false;
		}
	}
}

export function patchBackup(id: string, patch: Partial<DraftBackup>) {
	const b = readBackup(id);
	if (b) writeBackup({ ...b, ...patch });
}

export function removeBackup(id: string) {
	const s = storage();
	if (!s) return;
	try {
		s.removeItem(BACKUP_PREFIX + id);
		s.removeItem(ALIVE_PREFIX + id);
	} catch {}
}

// Heartbeat of the live editor: recovery does not touch a draft that is still
// open, in this tab or another.
export function touchAlive(id: string) {
	const s = storage();
	if (!s) return;
	try {
		s.setItem(ALIVE_PREFIX + id, String(Date.now()));
	} catch {}
}

export function aliveAt(id: string): number {
	const s = storage();
	if (!s) return 0;
	try {
		return Number(s.getItem(ALIVE_PREFIX + id) ?? 0) || 0;
	} catch {
		return 0;
	}
}

export function listBackups(): DraftBackup[] {
	const s = storage();
	if (!s) return [];
	const out: DraftBackup[] = [];
	try {
		for (let i = 0; i < s.length; i++) {
			const k = s.key(i);
			if (!k?.startsWith(BACKUP_PREFIX)) continue;
			const b = readBackup(k.slice(BACKUP_PREFIX.length));
			if (b?.v === 1) out.push(b);
		}
	} catch {}
	return out;
}
