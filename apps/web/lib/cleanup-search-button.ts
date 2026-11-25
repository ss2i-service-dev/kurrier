// ss2i : bouton « Nettoyage auto... » des recherches des deux interfaces (docs/plans/nettoyage-auto-recherche.md,
// MT11 et MT12), partie pure et textes uniques : visible ou non, actif ou non, et pourquoi. Cf.
// apps/web/test/cleanup-search-k.ts.
import { CLEANUP_ALLOWED_KINDS } from "../../../packages/common/src/cleanup-rules";

export type CleanupButtonState = { show: false } | { show: true; disabledReason: string | null };

// Dossier dont les fils partent a la Corbeille par une regle (jamais Corbeille, Spam, Envoyes, Brouillons...).
export function isCleanableKind(kind: string | null | undefined): boolean {
	return (CLEANUP_ALLOWED_KINDS as readonly string[]).includes(String(kind));
}

// Visible : requete non vide et proprietaire de l'identite (le serveur refuse de toute facon les autres).
// Desactive, avec explication : filtre « etoile » actif (un fil etoile n'est jamais nettoye) ou dossier courant
// non nettoyable hors mode « tous les dossiers ». `starredLabel` est le libelle du filtre tel qu'il est a
// l'ecran dans l'interface appelante ; `canExtend` dit si cette interface offre « Étendre à tous les dossiers ».
export function cleanupButtonState(input: {
	isOwner: boolean;
	query: string;
	starred: boolean;
	mailboxCleanable: boolean;
	allFolders: boolean;
	starredLabel: string;
	canExtend: boolean;
}): CleanupButtonState {
	if (!input.isOwner || !input.query.trim()) return { show: false };
	if (input.starred) {
		return { show: true, disabledReason: `Un fil étoilé n'est jamais nettoyé : désactivez le filtre « ${input.starredLabel} » pour créer une règle.` };
	}
	if (!input.allFolders && !input.mailboxCleanable) {
		const kinds = "seuls la boîte de réception, les archives et vos dossiers le permettent";
		return {
			show: true,
			disabledReason: input.canExtend
				? `Ce dossier ne se nettoie pas automatiquement (${kinds}) : cliquez sur « Étendre à tous les dossiers ».`
				: `Ce dossier ne se nettoie pas automatiquement (${kinds}).`,
		};
	}
	return { show: true, disabledReason: null };
}
