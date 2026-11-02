// Conversion d'un HTML de mail en texte lisible pour un LLM : blocs sur leurs lignes,
// citations prefixees de « > », liens conserves sous la forme « texte (url) »,
// entites decodees, espaces normalises. Pas de dependance : mailparser fournit deja
// textAsHtml, mais pas l'inverse.

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	laquo: "«",
	raquo: "»",
	hellip: "…",
	eacute: "é",
	egrave: "è",
	ecirc: "ê",
	agrave: "à",
	ccedil: "ç",
	ugrave: "ù",
	ocirc: "ô",
	icirc: "î",
	rsquo: "’",
	lsquo: "‘",
	rdquo: "”",
	ldquo: "“",
	ndash: "–",
	mdash: "—",
	euro: "€",
	copy: "©",
};

export function decodeEntities(input: string) {
	return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
		if (code[0] === "#") {
			const n =
				code[1] === "x" || code[1] === "X"
					? parseInt(code.slice(2), 16)
					: parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[code.toLowerCase()] ?? m;
	});
}

export function htmlToText(html: string): string {
	let s = html;
	s = s.replace(/<!--[\s\S]*?-->/g, "");
	s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
	// Citations : chaque blockquote prefixe ses lignes. On traite les plus internes
	// d'abord pour que les niveaux s'additionnent.
	let guard = 0;
	while (/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/i.test(s) && guard++ < 50) {
		s = s.replace(
			/<blockquote\b[^>]*>((?:(?!<blockquote\b)[\s\S])*?)<\/blockquote>/i,
			(_m, inner: string) => {
				const text = htmlToText(inner);
				return `\n\n${text
					.split("\n")
					.map((l) => `> ${l}`)
					.join("\n")}\n\n`;
			},
		);
	}
	s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
		const text = label.replace(/<[^>]+>/g, "").trim();
		if (!text || /^(mailto:|tel:|javascript:)/i.test(href)) return text;
		if (text === href || text.replace(/\/$/, "") === href.replace(/\/$/, "")) return href;
		return `${text} (${href})`;
	});
	s = s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, alt: string) =>
		alt.trim() ? `[image: ${alt.trim()}]` : "",
	);
	s = s.replace(/<img\b[^>]*>/gi, "");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol|pre|section|article|header|footer)>/gi, "\n");
	s = s.replace(/<li\b[^>]*>/gi, "- ");
	s = s.replace(/<\/t[dh]>/gi, "\t");
	s = s.replace(/<hr\b[^>]*>/gi, "\n----\n");
	s = s.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	s = s.replace(/\r/g, "");
	s = s
		.split("\n")
		.map((l) => l.replace(/[ \t ]+/g, " ").trim())
		.join("\n");
	s = s.replace(/\n{3,}/g, "\n\n");
	return s.trim();
}

// Texte d'un message : texte brut s'il existe, sinon HTML converti.
export function messageBodyText(message: {
	text?: string | null;
	html?: string | null;
}): string {
	const text = (message.text ?? "").trim();
	if (text) return text.replace(/\r/g, "");
	const html = (message.html ?? "").trim();
	return html ? htmlToText(html) : "";
}

// Coupe les citations usuelles (« Le ... a ecrit : », « On ... wrote: », lignes « > »,
// separateur « -----Original Message----- ») pour ne garder que la partie nouvelle.
export function stripQuotedText(text: string): string {
	const lines = text.split("\n");
	const markers = [
		/^On .{3,200} wrote:\s*$/i,
		/^Le .{3,200} a (e|é)crit\s*:\s*$/i,
		/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}\s*$/i,
		/^_{10,}\s*$/,
		/^De\s*:\s.+$/i,
		/^From:\s.+$/i,
	];
	let cut = lines.length;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i].trim();
		if (l.startsWith(">") || markers.some((re) => re.test(l))) {
			cut = i;
			break;
		}
	}
	const kept = lines.slice(0, cut).join("\n").trim();
	return kept || text;
}

export function truncate(text: string, max: number) {
	if (text.length <= max) return { text, truncated: false };
	return { text: `${text.slice(0, max)}\n[... truncated, ${text.length - max} more characters]`, truncated: true };
}
