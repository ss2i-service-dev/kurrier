// Un clic sur une notification la ferme (Samuel le 10/11 : « si on veut pas utiliser le CTA
// qui est dessus [...] mais qu'on veut laisser l'envoi s'ecouler, mais masquer cette
// notification. Il faut qu'on puisse cliquer sur la petite fenetre [...] que ca la degage »).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/toast-click-dismiss.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toastCloseButtonForClick } from "../lib/toast-click-dismiss";

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

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\ntoast-click-dismiss : tous les tests passent");
