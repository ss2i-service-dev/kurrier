// Selection de fils par plage (Maj+clic) dans les listes de mails, interface classique et
// nouvelle. Samuel le 05/11/2026 : « je peux plus faire de la selection de masse [...] en
// faisant Shift [...] tu le mets dans la suite de tests pour verifier que ca ne regresse
// pas ». Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
//   1) logique de plage (lib/thread-selection.ts) ;
//   2) cablage : toute liste qui rend une ligne de fil (WebmailListItem, KThreadRow) lui
//      passe orderedThreadIds, sinon Maj+clic ne coche qu'une ligne (regression du
//      05/11 : recherche, libelles, clients, orphelins).
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/thread-selection.ts
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { toggleThreadSelection } from "../lib/thread-selection";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};

const ids = ["a", "b", "c", "d", "e", "f"];
const sel = (s: { selectedThreadIds: Set<string> }) => [...s.selectedThreadIds].sort();

test("clic simple : coche une seule ligne et pose l'ancre", () => {
	const s = toggleThreadSelection(undefined, "b", false, ids);
	assert.deepEqual(sel(s), ["b"]);
	assert.equal(s.lastSelectedThreadId, "b");
});

test("Maj+clic plus bas : coche toute la plage depuis l'ancre", () => {
	let s = toggleThreadSelection(undefined, "b", false, ids);
	s = toggleThreadSelection(s, "e", true, ids);
	assert.deepEqual(sel(s), ["b", "c", "d", "e"]);
	assert.equal(s.lastSelectedThreadId, "e");
});

test("Maj+clic plus haut : plage dans l'autre sens", () => {
	let s = toggleThreadSelection(undefined, "e", false, ids);
	s = toggleThreadSelection(s, "b", true, ids);
	assert.deepEqual(sel(s), ["b", "c", "d", "e"]);
});

test("Maj+clic sur une case cochee : decoche la plage, garde le reste", () => {
	let s = toggleThreadSelection(undefined, "a", false, ids);
	s = toggleThreadSelection(s, "f", true, ids);
	s = toggleThreadSelection(s, "b", false, ids); // decoche b, ancre b
	s = toggleThreadSelection(s, "d", true, ids); // d coche -> decoche b..d
	assert.deepEqual(sel(s), ["a", "e", "f"]);
});

test("Maj+clic sans ancre : une seule ligne", () => {
	const s = toggleThreadSelection(undefined, "c", true, ids);
	assert.deepEqual(sel(s), ["c"]);
});

test("ancre disparue de la liste : une seule ligne", () => {
	let s = toggleThreadSelection(undefined, "zz", false, ["zz", ...ids]);
	s = toggleThreadSelection(s, "d", true, ids);
	assert.deepEqual(sel(s), ["d", "zz"]);
});

test("les autres cles du contexte sont conservees", () => {
	const prev = { selectedThreadIds: new Set<string>(), lastSelectedThreadId: undefined, activeMailbox: "inbox" };
	const s = toggleThreadSelection(prev, "a", false, ids);
	assert.equal((s as any).activeMailbox, "inbox");
	assert.equal(prev.selectedThreadIds.size, 0, "l'etat precedent n'est pas modifie");
});

test("meme fil dans deux dossiers (recherche) : plage correcte", () => {
	const dup = ["a", "b", "a", "c", "d"];
	let s = toggleThreadSelection(undefined, "b", false, dup);
	s = toggleThreadSelection(s, "d", true, dup);
	assert.deepEqual(sel(s), ["a", "b", "c", "d"]);
});

// Cablage : chaque <WebmailListItem ...> et <KThreadRow ...> recoit orderedThreadIds.
const webRoot = join(__dirname, "..");
const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		if (name === "node_modules" || name === ".next" || name === "test") return [];
		const p = join(dir, name);
		return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") ? [p] : [];
	});
const ROWS = ["WebmailListItem", "KThreadRow"];
const usages: { file: string; tag: string; ok: boolean }[] = [];
for (const file of [...walk(join(webRoot, "components")), ...walk(join(webRoot, "app"))]) {
	const src = readFileSync(file, "utf8");
	for (const tag of ROWS) {
		const re = new RegExp(`<${tag}(?![\\w-])`, "g");
		let m: RegExpExecArray | null;
		while ((m = re.exec(src))) {
			const end = src.indexOf("/>", m.index);
			const props = src.slice(m.index, end === -1 ? undefined : end);
			usages.push({ file: relative(webRoot, file), tag, ok: /\borderedThreadIds\s*=/.test(props) });
		}
	}
}

test("au moins une liste de chaque interface est trouvee", () => {
	for (const tag of ROWS) assert.ok(usages.some((u) => u.tag === tag), `aucun <${tag}> trouve`);
});

for (const u of usages) {
	test(`<${u.tag}> recoit orderedThreadIds dans ${u.file}`, () => {
		assert.ok(u.ok, "Maj+clic ne coche qu'une ligne dans cette liste");
	});
}

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
