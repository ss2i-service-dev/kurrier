// ss2i : archiver avec une duree de vie (partie pure, sans base ni Redis ; cf.
// apps/web/test/thread-expiry.ts et docs/plans/archive-duree-de-vie.md). L'echeance est une date
// seule : le debut du jour choisi, fuseau du navigateur, aucune heure saisie.

export type ExpiryPresetId = "1m" | "3m" | "6m" | "1y" | "2y";

export const EXPIRY_PRESETS: { id: ExpiryPresetId; months: number; label: string }[] = [
	{ id: "1m", months: 1, label: "1 mois" },
	{ id: "3m", months: 3, label: "3 mois" },
	{ id: "6m", months: 6, label: "6 mois" },
	{ id: "1y", months: 12, label: "1 an" },
	{ id: "2y", months: 24, label: "2 ans" },
];

// Au-dela, la date est une faute de frappe (2099) : archivage simple.
const MAX_YEARS = 10;

const pad = (n: number) => String(n).padStart(2, "0");

// Debut du jour local, now + months mois ; le 31/01 + 1 mois donne le 28/02, jamais le 03/03.
export function expiryFromPreset(id: ExpiryPresetId, now: Date): Date {
	const months = EXPIRY_PRESETS.find((p) => p.id === id)?.months ?? 0;
	const target = now.getMonth() + months;
	const year = now.getFullYear() + Math.floor(target / 12);
	const month = ((target % 12) + 12) % 12;
	const lastDay = new Date(year, month + 1, 0).getDate();
	return new Date(year, month, Math.min(now.getDate(), lastDay));
}

// Une Date si l'ISO est strictement apres now et a moins de 10 ans, sinon null (vide, invalide,
// passee, trop lointaine). Appelee cote web avant le job et cote worker avant l'ecriture.
export function parseExpiry(iso: unknown, now: Date): Date | null {
	const text = iso instanceof Date ? iso.toISOString() : typeof iso === "string" ? iso.trim() : "";
	if (!text) return null;
	const at = new Date(text);
	if (Number.isNaN(at.getTime())) return null;
	if (at.getTime() <= now.getTime()) return null;
	const limit = new Date(now.getTime());
	limit.setFullYear(limit.getFullYear() + MAX_YEARS);
	if (at.getTime() >= limit.getTime()) return null;
	return at;
}

// JJ/MM/AAAA, jour local (le meme que celui que l'utilisateur a choisi).
export function formatExpiry(date: Date): string {
	return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// AAAAMMJJHH en UTC : le jobId du tick change d'heure en heure, sans deux-points.
export function expiryBucket(now: Date): string {
	return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`;
}
