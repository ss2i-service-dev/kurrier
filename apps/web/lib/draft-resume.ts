// ss2i : reprise de la copie locale par l'editeur qui s'ouvre (lib/draft-backup.ts).
//
// Apres un rechargement force (deploiement), l'editeur rouvre le brouillon tel que le serveur
// l'a : la derniere frappe, pas encore enregistree, n'est plus a l'ecran, puis revient quand
// DraftBackupRecovery la renvoie dans Drafts (Samuel le 10/11). Ce qu'on tape ne disparait
// jamais : si la copie locale est plus recente que le serveur, l'editeur s'ouvre dessus.
import type { DraftBackup } from "@/lib/draft-backup";

// Meme seuil que DraftBackupRecovery : un editeur vivant bat chaque seconde.
export const ALIVE_MS = 10_000;
// Ecart d'horloge tolere entre ce navigateur (updatedAt de la copie) et le serveur
// (savedAt du brouillon) : en deca, la copie n'est pas jugee plus ancienne que le serveur.
export const CLOCK_SKEW_MS = 60_000;

export type EditorTarget = {
	// Brouillon du serveur ouvert dans l'editeur (prop `draft`), s'il y en a un.
	draftMessageId: string | null;
	// Dernier enregistrement serveur de ce brouillon, en millisecondes.
	draftUpdatedAt: number | null;
	// Reponse ou transfert d'un message (prop `message`).
	originalMessageId: string | null;
	mode: string | null;
	now: number;
	aliveAt: (id: string) => number;
};

// « replyAll » n'est qu'une reponse avec des Cc ; le serveur ne connait que reply / forward /
// new (le formulaire envoie « compose »).
const modeOf = (m: string | null | undefined) =>
	m === "reply" || m === "replyAll" ? "reply" : m === "forward" ? "forward" : "compose";

// Copie a reprendre, ou null. Jamais une copie envoyee, deja enregistree, ni dont un editeur est
// vivant (autre onglet). Brouillon ouvert : copie du meme brouillon, plus recente que lui.
// Sans brouillon : reponse ou transfert jamais enregistre (copie sans brouillon serveur), retrouve
// par message d'origine et mode. Plusieurs candidates : la plus recente.
export function pickBackupForEditor(
	backups: DraftBackup[],
	t: EditorTarget,
): DraftBackup | null {
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

// Meme lecture que packages/common/src/drafts.ts (parseAddressList), sans dependance serveur :
// « Nom <adresse> » ou « adresse », separes par des virgules.
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

// Ligne de brouillon (forme de `messages`, lue par l'en-tete, le corps, le pied et la citation
// de l'editeur) reconstruite depuis la copie. `base` : le brouillon du serveur, dont le reste
// (id, metaData.imap, revision) est conserve ; null pour une reponse jamais enregistree.
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
	// La citation ne part dans le formulaire que pour une reponse ou un transfert ; absente de la
	// copie (quota), le choix du brouillon serveur reste.
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
