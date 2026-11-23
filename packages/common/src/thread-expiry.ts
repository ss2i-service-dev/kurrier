// Archive for a chosen duration (pure part, no database or Redis; see
// apps/web/test/thread-expiry.ts). The expiry is a date only: the start of the chosen day, in the
// browser's time zone, no time typed.

export type ExpiryPresetId = "1m" | "3m" | "6m" | "1y" | "2y";

export const EXPIRY_PRESETS: { id: ExpiryPresetId; months: number; label: string }[] = [
	{ id: "1m", months: 1, label: "1 month" },
	{ id: "3m", months: 3, label: "3 months" },
	{ id: "6m", months: 6, label: "6 months" },
	{ id: "1y", months: 12, label: "1 year" },
	{ id: "2y", months: 24, label: "2 years" },
];

// Beyond this the date is a typo (2099): plain archive.
const MAX_YEARS = 10;

const pad = (n: number) => String(n).padStart(2, "0");

// Start of the local day, now + months months; Jan 31 + 1 month gives Feb 28, never Mar 3.
export function expiryFromPreset(id: ExpiryPresetId, now: Date): Date {
	const months = EXPIRY_PRESETS.find((p) => p.id === id)?.months ?? 0;
	const target = now.getMonth() + months;
	const year = now.getFullYear() + Math.floor(target / 12);
	const month = ((target % 12) + 12) % 12;
	const lastDay = new Date(year, month + 1, 0).getDate();
	return new Date(year, month, Math.min(now.getDate(), lastDay));
}

// A Date if the ISO string is strictly after now and less than 10 years away, otherwise null
// (empty, invalid, past, too far). Called on the web side before the job and on the worker side
// before the write.
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "19 Nov 2026", local day (the one the user picked). Month name rather than numbers: the same
// text on the server and in the browser, and no DD/MM against MM/DD ambiguity.
export function formatExpiry(date: Date): string {
	return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// YYYYMMDDHH in UTC: the tick's jobId changes hour by hour, without colons.
export function expiryBucket(now: Date): string {
	return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`;
}
