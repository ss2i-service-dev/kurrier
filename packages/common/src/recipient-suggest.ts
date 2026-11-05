// Ranking of the editor's recipient suggestions by real usage.
// Pure, no database: the server provides the candidates (recipient_stats, score already
// brought to now by recipient_decay, plus the address book at score 0) and the co-occurrence
// pairs of the recipients already entered (recipient_pairs, score brought to now); this
// function filters and orders.
//
// Score of a candidate = frecency + ASSOC_WEIGHT * association, where
//   frecency    = decaying score (sum of 0.5 ^ (age / 30 d) over the sends)
//                 + RECENT_BONUS * 0.5 ^ (age of the last send / 3 d)  (an address
//                 used yesterday rises even with a single send);
//   association = sum of the pair scores between the candidate and each recipient
//                 already entered (To, Cc, Bcc together).
// The typed text is only used to filter (prefix of the address, of the name, of a word of
// the name or of an address segment: local part, domain) and to break ties.

export const HALF_LIFE_DAYS = 30;
export const RECENT_BONUS = 2;
export const RECENT_BONUS_HALF_LIFE_DAYS = 3;
export const ASSOC_WEIGHT = 4;
// Beyond this number of recipients, a send does not feed the pairs (SQL side).
export const MAX_PAIR_RECIPIENTS = 10;

export type RecipientCandidate = {
	email: string;
	name?: string | null;
	// Score brought to now (recipient_decay); 0 for an address book contact never written to.
	score?: number | null;
	lastUsedAt?: Date | string | null;
	// Kept as-is in the result (id and avatar of the address book).
	id?: string | null;
	avatar?: string | null;
};

export type RecipientPair = {
	email: string; // recipient already entered
	other: string; // candidate
	score: number; // brought to now
};

export type RankedRecipient = RecipientCandidate & {
	email: string;
	name: string | null;
	total: number;
	match: number;
};

const norm = (s: string) => s.trim().toLowerCase();

// Quality of the text match: 0 none, 1 address segment (local part, domain, domain word),
// 2 name word, 3 start of the name, 4 start of the address.
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
	// Addresses already entered in To, Cc and Bcc: excluded, and the basis of the association.
	current: string[];
	// The user's addresses (their identities): excluded.
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

	// Deduplication by address: the first candidate (send statistics come before the address
	// book) wins, missing fields are filled in by the following ones.
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
