// ss2i (OI 10363) : rendu markdown des notes « Nouveautes ». Les notes sont les notres, le
// sous-ensemble suffit : titres (# a ####), paragraphes, listes a puces ou numerotees,
// citations, filet (---), et dans le texte gras, italique, code et liens. Le resultat est un
// arbre de blocs que le composant transforme en elements React : jamais de HTML injecte,
// donc rien a assainir, et aucune dependance de plus (le dossier n'a pas de lib markdown).

export type Inline =
	| { t: "text"; v: string }
	| { t: "strong" | "em"; c: Inline[] }
	| { t: "code"; v: string }
	| { t: "link"; href: string; c: Inline[] };

export type Block =
	| { t: "heading"; level: number; c: Inline[] }
	| { t: "p"; c: Inline[] }
	| { t: "list"; ordered: boolean; items: Inline[][] }
	| { t: "quote"; c: Inline[] }
	| { t: "hr" };

/** Liens permis : web, mail, ancre ou chemin du site. Le reste (javascript:, data:) reste du texte. */
export function safeHref(href: string): boolean {
	return /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(href);
}

const INLINE = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*(.+?)\*\*|\*([^*\s][^*]*?)\*/g;

export function parseInline(src: string): Inline[] {
	const out: Inline[] = [];
	let last = 0;
	for (const m of src.matchAll(INLINE)) {
		const at = m.index ?? 0;
		if (at > last) out.push({ t: "text", v: src.slice(last, at) });
		if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
		else if (m[2] !== undefined) {
			if (safeHref(m[3])) out.push({ t: "link", href: m[3], c: parseInline(m[2]) });
			else out.push({ t: "text", v: m[2] });
		} else if (m[4] !== undefined) out.push({ t: "strong", c: parseInline(m[4]) });
		else out.push({ t: "em", c: parseInline(m[5]) });
		last = at + m[0].length;
	}
	if (last < src.length) out.push({ t: "text", v: src.slice(last) });
	return out;
}

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+/;

export function parseMarkdown(src: string): Block[] {
	const lines = src.replace(/\r\n?/g, "\n").split("\n");
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim()) {
			i++;
			continue;
		}
		const h = /^(#{1,4})\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) {
			blocks.push({ t: "heading", level: h[1].length, c: parseInline(h[2]) });
			i++;
			continue;
		}
		if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
			blocks.push({ t: "hr" });
			i++;
			continue;
		}
		if (BULLET.test(line)) {
			const ordered = /^\s*\d/.test(line);
			const items: string[] = [];
			while (i < lines.length && lines[i].trim()) {
				if (BULLET.test(lines[i])) items.push(lines[i].replace(BULLET, "").trim());
				else if (/^\s+\S/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
				else break;
				i++;
			}
			blocks.push({ t: "list", ordered, items: items.map(parseInline) });
			continue;
		}
		if (/^>/.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && /^>/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, "").trim());
			blocks.push({ t: "quote", c: parseInline(quoted.join(" ")) });
			continue;
		}
		const para: string[] = [];
		while (
			i < lines.length &&
			lines[i].trim() &&
			!/^#{1,4}\s/.test(lines[i]) &&
			!BULLET.test(lines[i]) &&
			!/^>/.test(lines[i])
		) {
			para.push(lines[i++].trim());
		}
		blocks.push({ t: "p", c: parseInline(para.join(" ")) });
	}
	return blocks;
}
