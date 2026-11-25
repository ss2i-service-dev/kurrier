// ss2i : nettoyage automatique depuis une recherche (partie pure : types et constantes ; cf.
// docs/plans/nettoyage-auto-recherche.md, section 2). Une regle envoie a la Corbeille tout fil qui
// correspond a une recherche stricte et dont le message le plus recent depasse la duree de
// conservation. Table cleanup_rules (migration ss2i_012).

// Dossiers nettoyables, en allow-list : ni Envoyes (ce que l'utilisateur a ecrit n'est pas du bruit
// recu), ni Corbeille, Spam, Brouillons, Boite d'envoi, ni un kind inconnu.
export const CLEANUP_ALLOWED_KINDS = ["inbox", "archive", "custom"] as const;

export const CLEANUP_PRESETS: { id: string; days: number; label: string }[] = [
	{ id: "1w", days: 7, label: "1 semaine" },
	{ id: "1m", days: 30, label: "1 mois" },
	{ id: "3m", days: 91, label: "3 mois" },
	{ id: "6m", days: 182, label: "6 mois" },
	{ id: "1y", days: 365, label: "1 an" },
	{ id: "2y", days: 730, label: "2 ans" },
];

export const CLEANUP_MIN_DAYS = 1;
export const CLEANUP_MAX_DAYS = 3650;
// Fils par job, jobs par tick, pages de candidats Typesense par regle et par tick.
export const CLEANUP_BATCH = 200;
export const CLEANUP_MAX_JOBS_PER_TICK = 10;
export const CLEANUP_MAX_PAGES = 40;
// Plafond du decompte de l'apercu (affiche « 2 000+ » au-dela) et des regles par identite.
export const CLEANUP_PREVIEW_CAP = 2000;
export const CLEANUP_MAX_RULES_PER_IDENTITY = 50;

// Toujours construit cote serveur depuis la base (jamais depuis des chaines du client).
export type CleanupScope = {
	identityId: string;
	identityPublicId: string;
	workspacePublicId: string;
	// Dossiers nettoyables de l'identite, restreints au dossier de la regle s'il est pose.
	mailboxIds: string[];
	query: string;
	hasAttachment: boolean;
	onlyUnread: boolean;
	retentionDays: number;
};

export type CleanupRuleCtx = CleanupScope & {
	ruleId: string;
	ownerId: string;
	paused: boolean;
};

export type CleanupRow = {
	threadId: string;
	mailboxId: string;
	expiresAt: Date | null;
};
