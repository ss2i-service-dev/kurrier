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

// Memes champs que la recherche du webmail (apps/web/lib/actions/mailbox.ts), verifie par test.
export const CLEANUP_QUERY_BY = "subject,snippet,fromName,fromEmail,fromDomain,participants";
const CLEANUP_PAGE_SIZE = 250;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// Message a afficher si la recherche est trop large pour une regle permanente, sinon null. Un token
// positif (sans « - » devant) doit porter 3 lettres ou chiffres de suite : « a b c », « -banque » ou
// « * » attraperaient trop de fils (la contrainte de table et le matcher revalident).
export function cleanupQueryError(q: string): string | null {
	const t = String(q ?? "").trim();
	if (t.length < 3) return "Le texte cherché doit faire au moins 3 caractères.";
	if (t.length > 200) return "Le texte cherché doit faire 200 caractères au plus.";
	if (t === "*") return "Le texte cherché ne peut pas être un joker seul.";
	const positive = t.split(/\s+/).filter((w) => !w.startsWith("-"));
	if (!positive.some((w) => /[\p{L}\p{N}]{3,}/u.test(w))) {
		return "Le texte cherché doit contenir au moins un mot de 3 lettres ou chiffres, sans « - » devant.";
	}
	return null;
}

// Date limite : un fil est vieux si son message le plus recent est a cette date ou avant. Calculee une
// seule fois par passage et donnee au filtre Typesense comme au SQL.
export function cleanupCutoff(now: Date, days: number): Date {
	return new Date(now.getTime() - days * DAY_MS);
}

// Duree saisie librement (jour 1, semaine 7, mois 30, an 365), bornee a 1..3650 jours.
export function cleanupDaysFromFree(n: number, unit: "day" | "week" | "month" | "year"): number {
	const perUnit = { day: 1, week: 7, month: 30, year: 365 }[unit];
	const days = Math.round(Number(n) * perUnit);
	if (!Number.isFinite(days)) return CLEANUP_MIN_DAYS;
	return Math.min(CLEANUP_MAX_DAYS, Math.max(CLEANUP_MIN_DAYS, days));
}

// Parametres Typesense stricts : l'index ne fournit que des candidats (le SQL decide), mais il ne doit
// pas en ajouter par tolerance aux fautes, prefixes ou mots retires. createdAt est en millisecondes
// (toSearchDoc). Filtre sur les UUID de dossiers relus en base, jamais sur des slugs. null si un
// identifiant n'est pas un UUID ou si la liste de dossiers est vide.
export function cleanupSearchParams(scope: CleanupScope, opts: { cutoff?: Date | null; page: number }) {
	if (!scope.mailboxIds.length || !scope.mailboxIds.every((id) => UUID.test(id))) return null;
	const filters = [
		`workspacePublicId:=${JSON.stringify(scope.workspacePublicId)}`,
		`identityPublicId:=${JSON.stringify(scope.identityPublicId)}`,
		`mailboxId:=[${scope.mailboxIds.map((id) => `\`${id}\``).join(",")}]`,
	];
	if (opts.cutoff) filters.push(`createdAt:<=${opts.cutoff.getTime()}`);
	if (scope.hasAttachment) filters.push("hasAttachment:=1");
	if (scope.onlyUnread) filters.push("unread:=1");
	return {
		q: scope.query.trim(),
		query_by: CLEANUP_QUERY_BY,
		filter_by: filters.join(" && "),
		num_typos: 0,
		prefix: false,
		drop_tokens_threshold: 0,
		typo_tokens_threshold: 0,
		split_join_tokens: "off" as const,
		exhaustive_search: true,
		sort_by: "createdAt:asc",
		group_by: "threadId",
		group_limit: 1,
		per_page: CLEANUP_PAGE_SIZE,
		page: opts.page,
		include_fields: "id,threadId,mailboxId",
	};
}
