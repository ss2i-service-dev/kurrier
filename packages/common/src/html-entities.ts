// ss2i : Outlook (OWA, Outlook pour Android) ecrit un emoji hors du plan de base en deux
// references numeriques de demi-surrogates UTF-16, par exemple 🙂 en « &#55357;&#56898; ».
// Le parseur HTML remplace chaque reference de surrogate par U+FFFD : le navigateur affiche
// « �� » (fil Antellia du 29/10/2026). On recompose chaque paire contigue en une seule
// reference (« &#128578; ») avant tout passage par le DOM. Une moitie isolee reste telle quelle.

const NUMERIC_ENTITY = /&#(x[0-9a-f]+|\d+);?/gi;

function entityValue(code: string): number {
	return code[0] === "x" || code[0] === "X"
		? parseInt(code.slice(1), 16)
		: parseInt(code, 10);
}

const isHigh = (n: number) => n >= 0xd800 && n <= 0xdbff;
const isLow = (n: number) => n >= 0xdc00 && n <= 0xdfff;

export function joinSurrogateEntities(html: string): string {
	if (!html || html.indexOf("&#") === -1) return html;
	let out = "";
	let last = 0;
	// Reference de demi-surrogate haut en attente de son complement : debut et valeur.
	let pending: { start: number; value: number } | null = null;
	NUMERIC_ENTITY.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = NUMERIC_ENTITY.exec(html))) {
		const start = m.index;
		const value = entityValue(m[1]);
		if (pending && isLow(value) && start === last) {
			out += `&#${(pending.value - 0xd800) * 0x400 + (value - 0xdc00) + 0x10000};`;
			last = start + m[0].length;
			pending = null;
			continue;
		}
		if (pending) {
			out += html.slice(pending.start, last);
			pending = null;
		}
		if (isHigh(value)) {
			out += html.slice(last, start);
			pending = { start, value };
			last = start + m[0].length;
		}
	}
	if (pending) out += html.slice(pending.start, last);
	return out + html.slice(last);
}
