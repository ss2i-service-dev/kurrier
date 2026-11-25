// ss2i : bouton « Nettoyage auto... » de la recherche de la nouvelle interface (docs/plans/nettoyage-auto-recherche.md,
// MT12), partie pure : visible ou non, actif ou non, et pourquoi. Cf. apps/web/test/cleanup-search-k.ts.
import { CLEANUP_ALLOWED_KINDS } from "../../../packages/common/src/cleanup-rules";

export type CleanupButtonState = { show: false } | { show: true; disabledReason: string | null };

// Visible : requete non vide et proprietaire de l'identite (le serveur refuse de toute facon les autres).
// Desactive, avec explication : filtre « etoile » actif (un fil etoile n'est jamais nettoye) ou dossier courant
// hors de CLEANUP_ALLOWED_KINDS hors mode « tous les dossiers » (Corbeille, Spam, Brouillons...).
export function cleanupButtonState(input: {
	isOwner: boolean;
	query: string;
	starred: boolean;
	mailboxKind: string | null;
	allFolders: boolean;
}): CleanupButtonState {
	if (!input.isOwner || !input.query.trim()) return { show: false };
	if (input.starred) {
		return { show: true, disabledReason: "Un fil étoilé n'est jamais nettoyé : retirez le filtre « Étoilés » pour créer une règle." };
	}
	if (!input.allFolders && !(CLEANUP_ALLOWED_KINDS as readonly string[]).includes(String(input.mailboxKind))) {
		return { show: true, disabledReason: "Ce dossier ne se nettoie pas automatiquement (seuls la boîte de réception, les archives et vos dossiers le permettent)." };
	}
	return { show: true, disabledReason: null };
}
