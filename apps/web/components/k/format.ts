// SS2i : formats d'affichage de la nouvelle interface (dates, noms).

const sameDay = (a: Date, b: Date) =>
	a.getFullYear() === b.getFullYear() &&
	a.getMonth() === b.getMonth() &&
	a.getDate() === b.getDate();

/** Date courte de la liste : 14:05, Hier, lun., 2 nov., 02/11/2024. */
export function listDate(input?: string | number | Date | null): string {
	if (!input) return "";
	const d = new Date(input);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	if (sameDay(d, now)) {
		return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
	}
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (sameDay(d, yesterday)) return "Hier";
	const diffDays = (now.getTime() - d.getTime()) / 86_400_000;
	if (diffDays < 6) {
		return d.toLocaleDateString("fr-FR", { weekday: "short" });
	}
	if (d.getFullYear() === now.getFullYear()) {
		return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
	}
	return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Date complete de l'en-tete d'un message : mar. 3 nov. 2026, 14:05. */
export function fullDate(input?: string | number | Date | null): string {
	if (!input) return "";
	const d = new Date(input);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString("fr-FR", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** Date relative courte pour l'en-tete d'un message : il y a 2 h, sinon listDate. */
export function relativeDate(input?: string | number | Date | null): string {
	if (!input) return "";
	const d = new Date(input);
	const mins = Math.round((Date.now() - d.getTime()) / 60_000);
	if (mins < 1) return "à l'instant";
	if (mins < 60) return `il y a ${mins} min`;
	const hours = Math.round(mins / 60);
	if (hours < 12) return `il y a ${hours} h`;
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
 * Libelle des correspondants d'un fil, sans soi-meme sauf s'il n'y a que soi.
 * Un seul correspondant : nom complet. Plusieurs : prenoms, « moi » en dernier.
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
	if (others.length === 0) return { label: me ? "moi" : "(inconnu)", primary: null };
	if (others.length === 1 && !me) return { label: displayName(others[0]), primary: others[0] };
	const names = others.slice(0, 3).map(firstName);
	if (others.length > 3) names.push(`+${others.length - 3}`);
	if (me) names.push("moi");
	return { label: names.join(", "), primary: others[0] };
}

export function formatBytes(n?: number | null): string {
	if (!n && n !== 0) return "";
	if (n < 1024) return `${n} o`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
	return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`;
}

const MAILBOX_TITLES: Record<string, string> = {
	inbox: "Boîte de réception",
	sent: "Envoyés",
	drafts: "Brouillons",
	archive: "Archives",
	spam: "Spam",
	trash: "Corbeille",
	outbox: "Boîte d'envoi",
};

export function mailboxTitle(kind?: string | null, name?: string | null): string {
	if (kind && kind !== "custom" && MAILBOX_TITLES[kind]) return MAILBOX_TITLES[kind];
	return name || "Dossier";
}
