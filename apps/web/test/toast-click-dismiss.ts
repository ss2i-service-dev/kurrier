// Un clic sur une notification la ferme (Samuel le 10/11 : « si on veut pas utiliser le CTA
// qui est dessus [...] mais qu'on veut laisser l'envoi s'ecouler, mais masquer cette
// notification. Il faut qu'on puisse cliquer sur la petite fenetre [...] que ca la degage »).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/toast-click-dismiss.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { burstParticles, toastCloseButtonForClick, TOAST_POP_MS } from "../lib/toast-click-dismiss";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

// Arbre minimal : chaque noeud connait ses selecteurs et son parent ; closest remonte.
type Fake = { name: string; matches: string[]; parent: Fake | null; children: Fake[]; closest(sel: string): Fake | null; querySelector(sel: string): Fake | null };
const node = (name: string, matches: string[], parent: Fake | null = null): Fake => {
	const n: Fake = {
		name,
		matches,
		parent,
		children: [],
		closest(sel) {
			const wanted = sel.split(",").map((s) => s.trim());
			for (let c: Fake | null = n; c; c = c.parent) if (c.matches.some((m) => wanted.includes(m))) return c;
			return null;
		},
		querySelector(sel) {
			const wanted = sel.split(",").map((s) => s.trim());
			const walk = (x: Fake): Fake | null => {
				for (const ch of x.children) {
					if (ch.matches.some((m) => wanted.includes(m))) return ch;
					const r = walk(ch);
					if (r) return r;
				}
				return null;
			};
			return walk(n);
		},
	};
	parent?.children.push(n);
	return n;
};

const toast = node("li", ["[data-sonner-toast]"]);
const close = node("close", ["button", "[data-close-button]"], toast);
const content = node("content", ["[data-content]"], toast);
const title = node("title", ["[data-title]"], content);
const action = node("action", ["button", "[data-button]"], toast);
const cancel = node("cancel", ["button", "[data-button]", "[data-cancel]"], toast);
const link = node("a", ["a"], content);
const outside = node("div", ["div"]);

test("clic sur le texte de la notification : son bouton de fermeture est renvoye", () => {
	assert.equal(toastCloseButtonForClick(title as any)?.name, "close");
	assert.equal(toastCloseButtonForClick(toast as any)?.name, "close");
});

test("clic sur Envoyer maintenant ou Annuler : la notification laisse faire le bouton", () => {
	assert.equal(toastCloseButtonForClick(action as any), null);
	assert.equal(toastCloseButtonForClick(cancel as any), null);
});

test("clic sur un lien dans la notification : rien", () => {
	assert.equal(toastCloseButtonForClick(link as any), null);
});

test("clic hors notification : rien", () => {
	assert.equal(toastCloseButtonForClick(outside as any), null);
	assert.equal(toastCloseButtonForClick(null), null);
});

test("notification non fermable (dismissible: false) : rien", () => {
	const locked = node("li", ["[data-sonner-toast]", '[data-dismissible="false"]']);
	const txt = node("t", ["[data-title]"], locked);
	node("close", ["button", "[data-close-button]"], locked);
	assert.equal(toastCloseButtonForClick(txt as any), null);
});

test("le Toaster est monte avec le bouton de fermeture et l'ecoute du clic", () => {
	const src = readFileSync(join(__dirname, "../components/ui/sonner.tsx"), "utf8");
	assert.match(src, /closeButton/);
	assert.match(src, /toastCloseButtonForClick/);
});

// Fermeture « mignonne » (Samuel le 10/11 : « un truc qui eclate [...] que ce soit un peu mignon »).
test("eclat : des bulles reparties tout autour du clic, de tailles et couleurs variees", () => {
	const ps = burstParticles(14, () => 0.5);
	assert.equal(ps.length, 14);
	const angles = ps.map((p) => Math.atan2(p.dy, p.dx));
	assert.ok(Math.max(...angles) - Math.min(...angles) > 1.6 * Math.PI, "tout le tour");
	for (const p of ps) {
		const d = Math.hypot(p.dx, p.dy);
		assert.ok(d >= 20 && d <= 80, `distance ${d}`);
		assert.ok(p.size >= 4 && p.size <= 12, `taille ${p.size}`);
		assert.match(p.color, /^#[0-9a-f]{6}$/i);
	}
	assert.ok(new Set(ps.map((p) => p.color)).size >= 4, "plusieurs couleurs");
});

test("eclat bref : la notification part en moins d'un tiers de seconde", () => {
	assert.ok(TOAST_POP_MS >= 120 && TOAST_POP_MS <= 300);
});

test("animation : gonfle puis disparait, rien si le systeme demande moins de mouvement", () => {
	const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
	assert.match(css, /@keyframes ss2i-toast-pop/);
	assert.match(css, /prefers-reduced-motion/);
	const ui = readFileSync(join(__dirname, "../components/ui/sonner.tsx"), "utf8");
	assert.match(ui, /burstParticles/);
	assert.match(ui, /prefers-reduced-motion/);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\ntoast-click-dismiss : tous les tests passent");
