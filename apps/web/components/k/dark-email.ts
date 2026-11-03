// SS2i (Outlook) : mode sombre d'un mail HTML sans filtre CSS. Chaque couleur de
// fond et de texte fixee par le mail est recalculee (luminosite inversee, teinte
// et saturation gardees) : un fond blanc devient le gris de la carte, un texte
// noir devient clair, un bouton bleu reste bleu. Les images ne sont pas touchees
// et gardent leurs couleurs exactes (un filtre invert + hue-rotate sur tout le
// mail, meme compense sur les images, deformait les couleurs saturees : logos et
// signatures teintes).

type RGBA = [number, number, number, number];

function parse(c: string): RGBA | null {
	const m = c.match(/rgba?\(([^)]+)\)/);
	if (!m) return null;
	const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
	return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

function toHsl([r, g, b]: RGBA): [number, number, number] {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b), min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	return [h * 60, s, l];
}

function css(h: number, s: number, l: number, a: number) {
	const L = Math.max(0, Math.min(1, l));
	return `hsla(${h.toFixed(1)}, ${(s * 100).toFixed(1)}%, ${(L * 100).toFixed(1)}%, ${a})`;
}

// Luminance percue (pour decider si une couleur est « claire »).
function luma([r, g, b]: RGBA) {
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Fond clair -> sombre (blanc -> ~gris de la carte, #19191b). Fond deja sombre : garde. */
function darkBg(c: RGBA): string | null {
	if (c[3] === 0 || luma(c) < 0.45) return null;
	const [h, s, l] = toHsl(c);
	return css(h, s * 0.6, 0.1 + (1 - l) * 0.75, c[3]);
}

function hslToRgb(h: number, s: number, l: number): RGBA {
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0) * 255, f(8) * 255, f(4) * 255, 1];
}

/**
 * Texte sombre -> clair (noir -> ~#ececea). La luminosite percue des bleus et
 * violets est faible meme quand leur « lightness » est moyenne : on eclaircit
 * jusqu'a une luminance percue suffisante sur fond sombre. Texte deja clair : garde.
 */
function lightText(c: RGBA): string | null {
	if (c[3] === 0 || luma(c) > 0.55) return null;
	const [h, s0, l] = toHsl(c);
	const s = Math.min(1, s0 * 0.85);
	let L = Math.max(0.93 - l * 0.6, 0.62);
	while (L < 0.95 && luma(hslToRgb(h, s, L)) < 0.62) L += 0.02;
	return css(h, s, L, c[3]);
}

const SKIP = new Set(["IMG", "PICTURE", "VIDEO", "SVG", "CANVAS", "STYLE", "SCRIPT", "BR"]);

export function adaptEmailToDark(root: HTMLElement) {
	const els: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))];
	// Lecture de tous les styles d'abord, ecriture ensuite (un seul calcul de mise en page).
	const plan: [HTMLElement, string | null, string | null, string | null][] = [];
	for (const el of els) {
		if (SKIP.has(el.tagName.toUpperCase()) || el.closest("svg")) continue;
		const cs = getComputedStyle(el);
		const bg = parse(cs.backgroundColor);
		const fg = parse(cs.color);
		const border = cs.borderTopStyle !== "none" ? parse(cs.borderTopColor) : null;
		plan.push([
			el,
			el === root || !bg ? null : darkBg(bg),
			fg ? lightText(fg) : null,
			border && luma(border) > 0.6 ? css(...toHsl(border).slice(0, 2) as [number, number], 0.28, border[3]) : null,
		]);
	}
	for (const [el, bg, fg, border] of plan) {
		if (bg) el.style.setProperty("background-color", bg, "important");
		if (fg) el.style.setProperty("color", fg, "important");
		if (border) el.style.setProperty("border-color", border, "important");
	}
}
