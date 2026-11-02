// ss2i : classement des suggestions de destinataires de l'editeur par usage reel.
// Pur, sans base : le serveur fournit les candidats (ss2i_recipient_stats, score deja
// ramene a maintenant par ss2i_decay, plus le carnet a score 0), les paires de
// co-occurrence des destinataires deja saisis (ss2i_recipient_pairs, score ramene a
// maintenant) ; cette fonction filtre et ordonne.
//
// Score d'un candidat = frecency + ASSOC_WEIGHT * association, ou
//   frecency    = score decroissant (somme des 0,5 ^ (age / 30 j) sur les envois)
//                 + RECENT_BONUS * 0,5 ^ (age du dernier envoi / 3 j)  (une adresse
//                 utilisee hier remonte meme avec un seul envoi) ;
//   association = somme des scores de paire entre le candidat et chaque destinataire
//                 deja saisi (To, Cc, Bcc confondus).
// Le texte tape ne sert qu'a filtrer (prefixe de l'adresse, du nom, d'un mot du nom
// ou d'un segment de l'adresse : partie locale, domaine) et a departager a score egal.

export const HALF_LIFE_DAYS = 30;
export const RECENT_BONUS = 2;
export const RECENT_BONUS_HALF_LIFE_DAYS = 3;
export const ASSOC_WEIGHT = 4;
// Au-dela de ce nombre de destinataires, un envoi n'alimente pas les paires (cote SQL).
export const MAX_PAIR_RECIPIENTS = 10;

export type RecipientCandidate = {
	email: string;
	name?: string | null;
	// Score ramene a maintenant (ss2i_decay) ; 0 pour un contact du carnet jamais ecrit.
	score?: number | null;
	lastUsedAt?: Date | string | null;
	// Conserves tels quels dans le resultat (id et avatar du carnet).
	id?: string | null;
	avatar?: string | null;
};

export type RecipientPair = {
	email: string; // destinataire deja saisi
	other: string; // candidat
	score: number; // ramene a maintenant
};

export type RankedRecipient = RecipientCandidate & {
	email: string;
	name: string | null;
	total: number;
	match: number;
};

const norm = (s: string) => s.trim().toLowerCase();

// Qualite de la correspondance textuelle : 0 aucune, 1 segment de l'adresse (partie
// locale, domaine, mot du domaine), 2 mot du nom, 3 debut du nom, 4 debut de l'adresse.
export function textMatch(query: string, email: string, name?: string | null): number {
	const q = norm(query);
	if (!q) return 4;
	const e = email.toLowerCase();
	if (e.startsWith(q)) return 4;
	const n = (name ?? "").toLowerCase().trim();
	if (n && n.startsWith(q)) return 3;
	if (n && n.split(/[\s\-'".,()]+/).some((w) => w && w.startsWith(q))) return 2;
	const [local = "", domain = ""] = e.split("@");
	const segments = [local, domain, ...local.split(/[._+-]+/), ...domain.split(/[._-]+/)];
	if (segments.some((seg) => seg && seg.startsWith(q))) return 1;
	return 0;
}

export function ageDays(lastUsedAt: Date | string | null | undefined, now: Date): number {
	if (!lastUsedAt) return Number.POSITIVE_INFINITY;
	const t = new Date(lastUsedAt).getTime();
	if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
	return Math.max(0, (now.getTime() - t) / 86_400_000);
}

export function frecency(c: RecipientCandidate, now: Date): number {
	const base = Math.max(0, Number(c.score ?? 0) || 0);
	const age = ageDays(c.lastUsedAt, now);
	const bonus = Number.isFinite(age)
		? RECENT_BONUS * Math.pow(0.5, age / RECENT_BONUS_HALF_LIFE_DAYS)
		: 0;
	return base + bonus;
}

export function rankRecipientSuggestions(opts: {
	query: string;
	// Adresses deja saisies dans To, Cc et Bcc : exclues, et base de l'association.
	current: string[];
	// Adresses de l'utilisateur (ses identites) : exclues.
	own?: string[];
	candidates: RecipientCandidate[];
	pairs?: RecipientPair[];
	now?: Date;
	limit?: number;
}): RankedRecipient[] {
	const now = opts.now ?? new Date();
	const limit = opts.limit ?? 10;
	const current = new Set(opts.current.map(norm).filter(Boolean));
	const excluded = new Set([...current, ...(opts.own ?? []).map(norm)]);

	const assoc = new Map<string, number>();
	for (const p of opts.pairs ?? []) {
		if (!current.has(norm(p.email))) continue;
		const other = norm(p.other);
		assoc.set(other, (assoc.get(other) ?? 0) + Math.max(0, Number(p.score) || 0));
	}

	// Dedoublonnage par adresse : le premier candidat (les statistiques d'envoi viennent
	// avant le carnet) garde la main, les champs manquants sont completes par les suivants.
	const newest = (a?: Date | string | null, b?: Date | string | null) =>
		ageDays(a, now) <= ageDays(b, now) ? a ?? null : b ?? null;
	const byEmail = new Map<string, RecipientCandidate & { email: string }>();
	for (const c of opts.candidates) {
		const email = norm(c.email ?? "");
		if (!email || !email.includes("@") || excluded.has(email)) continue;
		const prev = byEmail.get(email);
		if (!prev) {
			byEmail.set(email, { ...c, email });
			continue;
		}
		byEmail.set(email, {
			...prev,
			name: (prev.name ?? "").trim() || c.name || null,
			id: prev.id ?? c.id ?? null,
			avatar: prev.avatar ?? c.avatar ?? null,
			score: Math.max(Number(prev.score) || 0, Number(c.score) || 0),
			lastUsedAt: newest(prev.lastUsedAt, c.lastUsedAt),
		});
	}

	const ranked: RankedRecipient[] = [];
	for (const c of byEmail.values()) {
		const match = textMatch(opts.query, c.email, c.name);
		if (!match) continue;
		const total = frecency(c, now) + ASSOC_WEIGHT * (assoc.get(c.email) ?? 0);
		ranked.push({ ...c, name: (c.name ?? "").trim() || null, total, match });
	}

	ranked.sort(
		(a, b) =>
			b.total - a.total ||
			b.match - a.match ||
			ageDays(a.lastUsedAt, now) - ageDays(b.lastUsedAt, now) ||
			a.email.localeCompare(b.email),
	);
	return ranked.slice(0, limit);
}
