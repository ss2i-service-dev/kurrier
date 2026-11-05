// Display formats of the modern interface (dates, names).

const sameDay = (a: Date, b: Date) =>
	a.getFullYear() === b.getFullYear() &&
	a.getMonth() === b.getMonth() &&
	a.getDate() === b.getDate();

/** Short list date: 2:05 PM, Yesterday, Mon, 2 Nov, 02/11/2024 (browser locale). */
export function listDate(input?: string | number | Date | null): string {
	if (!input) return "";
	const d = new Date(input);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	if (sameDay(d, now)) {
		return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	}
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (sameDay(d, yesterday)) return "Yesterday";
	const diffDays = (now.getTime() - d.getTime()) / 86_400_000;
	if (diffDays < 6) {
		return d.toLocaleDateString(undefined, { weekday: "short" });
	}
	if (d.getFullYear() === now.getFullYear()) {
		return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
	}
	return d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Full date of a message header: Tue, 3 Nov 2026, 2:05 PM (browser locale). */
export function fullDate(input?: string | number | Date | null): string {
	if (!input) return "";
	const d = new Date(input);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString(undefined, {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Short relative date for a message header: 2 h ago, otherwise listDate. */
export function relativeDate(input?: string | number | Date | null): string {
	if (!input) return "";
	const d = new Date(input);
	const mins = Math.round((Date.now() - d.getTime()) / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins} min ago`;
	const hours = Math.round(mins / 60);
	if (hours < 12) return `${hours} h ago`;
	return listDate(d);
}

type Person = { n?: string | null; e?: string | null };

export function displayName(p: Person): string {
	const n = p.n?.trim();
	if (n) return n;
	const e = p.e?.trim() ?? "";
	return e.split("@")[0] || e;
}

export function firstName(p: Person): string {
	const n = p.n?.trim();
	if (n) return n.split(/\s+/)[0];
	return displayName(p);
}

/**
 * Label for the participants of a thread, leaving out yourself unless you are
 * the only one. A single participant: full name. Several: first names, "me" last.
 */
export function correspondents(
	people: Person[],
	own: Set<string>,
): { label: string; primary: Person | null } {
	const seen = new Set<string>();
	const others: Person[] = [];
	let me = false;
	for (const p of people) {
		const e = p.e?.trim().toLowerCase();
		if (!e || seen.has(e)) continue;
		seen.add(e);
		if (own.has(e)) me = true;
		else others.push(p);
	}
	if (others.length === 0) return { label: me ? "me" : "(unknown)", primary: null };
	if (others.length === 1 && !me) return { label: displayName(others[0]), primary: others[0] };
	const names = others.slice(0, 3).map(firstName);
	if (others.length > 3) names.push(`+${others.length - 3}`);
	if (me) names.push("me");
	return { label: names.join(", "), primary: others[0] };
}

export function formatBytes(n?: number | null): string {
	if (!n && n !== 0) return "";
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const MAILBOX_TITLES: Record<string, string> = {
	inbox: "Inbox",
	sent: "Sent",
	drafts: "Drafts",
	archive: "Archive",
	spam: "Spam",
	trash: "Trash",
	outbox: "Outbox",
};

export function mailboxTitle(kind?: string | null, name?: string | null): string {
	if (kind && kind !== "custom" && MAILBOX_TITLES[kind]) return MAILBOX_TITLES[kind];
	return name || "Folder";
}
