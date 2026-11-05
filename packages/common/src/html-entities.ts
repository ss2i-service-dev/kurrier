// Outlook (OWA, Outlook for Android) writes an emoji outside the basic plane as two
// numeric references of UTF-16 half-surrogates, e.g. a smiling face as "&#55357;&#56898;".
// The HTML parser replaces each surrogate reference with U+FFFD, so the browser shows
// "��". Each contiguous pair is recomposed into a single reference ("&#128578;") before
// any pass through the DOM. An isolated half is left as is.

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
	// Pending high half-surrogate reference waiting for its other half: start and value.
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
