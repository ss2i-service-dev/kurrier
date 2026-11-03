// ss2i : copie locale (localStorage) de chaque brouillon en cours d'ecriture.
//
// L'enregistrement serveur (saveDraft) peut echouer sans que l'editeur le sache vraiment :
// apres un redeploiement, l'onglet ouvert appelle des Server Actions qui n'existent plus
// (« Failed to find Server Action »), pendant un redemarrage le proxy renvoie sa page
// d'erreur, puis une navigation finit en rechargement complet et le texte disparait.
// La copie locale ne depend d'aucun serveur : elle est ecrite a chaque frappe et relue au
// chargement suivant (DraftBackupRecovery), qui la renvoie dans Drafts.

export const BACKUP_PREFIX = "ss2i-draft-backup:";
const ALIVE_PREFIX = "ss2i-draft-alive:";

export type DraftBackupPayload = Record<string, string | null>;

export type DraftBackup = {
	v: 1;
	id: string;
	identityPublicId: string;
	draftMessageId: string | null;
	payload: DraftBackupPayload;
	key: string;
	// Cle du dernier etat confirme par le serveur : egale a `key`, rien a recuperer.
	savedKey: string | null;
	// Pose a l'envoi, efface par Undo ou un echec : un message envoye n'est pas recupere.
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
		// Quota : la citation (souvent la plus grosse partie) est sacrifiee, le texte reste.
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

// Battement de l'editeur vivant : la recuperation ne touche pas a un brouillon encore
// ouvert, dans cet onglet ou un autre.
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
