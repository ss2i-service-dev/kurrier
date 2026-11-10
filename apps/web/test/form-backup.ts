// Copie locale des formulaires d'agenda (Samuel le 10/11 : « pour les calendriers comme les
// mails, on est en 2026 » : rien de ce qu'on tape ne doit se perdre sur un rechargement, que
// l'onglet soit recharge de force apres un deploiement, par F5 ou par un plantage).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/form-backup.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Faux localStorage en memoire (le module lit window.localStorage a chaque appel).
class MemoryStorage {
	data = new Map<string, string>();
	full = false;
	get length() {
		return this.data.size;
	}
	key(i: number) {
		return [...this.data.keys()][i] ?? null;
	}
	getItem(k: string) {
		return this.data.get(k) ?? null;
	}
	setItem(k: string, v: string) {
		if (this.full) throw new DOMException("quota", "QuotaExceededError");
		this.data.set(k, String(v));
	}
	removeItem(k: string) {
		this.data.delete(k);
	}
}
const store = new MemoryStorage();
(globalThis as any).window = { localStorage: store };

import {
	FORM_BACKUP_PREFIX,
	agendaEditKey,
	agendaFromMailKey,
	agendaNewKey,
	differsFromInitial,
	listFormBackups,
	purgeFormBackups,
	readFormBackup,
	recentFormBackup,
	removeFormBackup,
	restorableBackup,
	syncFormBackup,
	writeFormBackup,
} from "../lib/form-backup";

let failures = 0;
const test = (label: string, fn: () => void) => {
	store.data.clear();
	store.full = false;
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const DAY = 24 * 3600 * 1000;
const initial = { v: { title: "", start: "2026-11-12T09:00", attendees: [] as string[] }, scope: "occurrence" };

test("cles stables par formulaire", () => {
	assert.equal(agendaNewKey("ident1"), "agenda:new:ident1");
	assert.equal(agendaEditKey("evt1"), "agenda:edit:evt1");
	assert.equal(agendaFromMailKey("msg1"), "agenda:from-mail:msg1");
});

test("ecriture puis lecture : { v: 1, key, values, updatedAt }", () => {
	assert.equal(writeFormBackup("agenda:new:i1", { title: "Point client" }, 1000), true);
	assert.ok(store.data.has(`${FORM_BACKUP_PREFIX}agenda:new:i1`));
	assert.equal(FORM_BACKUP_PREFIX, "ss2i-form-backup:");
	assert.deepEqual(readFormBackup("agenda:new:i1"), { v: 1, key: "agenda:new:i1", values: { title: "Point client" }, updatedAt: 1000 });
});

test("lecture : absente, illisible ou d'une autre version -> null", () => {
	assert.equal(readFormBackup("agenda:new:rien"), null);
	store.data.set(`${FORM_BACKUP_PREFIX}agenda:new:x`, "{pas du json");
	assert.equal(readFormBackup("agenda:new:x"), null);
	store.data.set(`${FORM_BACKUP_PREFIX}agenda:new:y`, JSON.stringify({ v: 2, key: "agenda:new:y", values: {}, updatedAt: 1 }));
	assert.equal(readFormBackup("agenda:new:y"), null);
});

test("ecrire de nouveau remplace la copie de la meme cle", () => {
	writeFormBackup("agenda:new:i1", { title: "a" }, 1);
	writeFormBackup("agenda:new:i1", { title: "ab" }, 2);
	assert.equal(listFormBackups().length, 1);
	assert.deepEqual(readFormBackup("agenda:new:i1")?.values, { title: "ab" });
});

test("suppression", () => {
	writeFormBackup("agenda:edit:e1", { title: "a" });
	removeFormBackup("agenda:edit:e1");
	assert.equal(readFormBackup("agenda:edit:e1"), null);
	removeFormBackup("agenda:edit:inconnue");
});

test("difference avec l'etat initial : ordre des cles et champs absents ignores", () => {
	assert.equal(differsFromInitial({ scope: "occurrence", v: { attendees: [], start: "2026-11-12T09:00", title: "" } }, initial), false);
	assert.equal(differsFromInitial({ v: { ...initial.v, title: "Point" }, scope: "occurrence" }, initial), true);
	assert.equal(differsFromInitial({ v: { ...initial.v, attendees: ["a@b.fr"] }, scope: "occurrence" }, initial), true);
	// undefined et champ absent sont la meme chose apres un aller-retour JSON
	assert.equal(differsFromInitial({ v: { ...initial.v, location: undefined }, scope: "occurrence" }, { ...initial, v: { ...initial.v } }), false);
	// seuls les champs de l'etat initial comptent (le reste, ex. la cible a rouvrir, est ignore)
	assert.equal(differsFromInitial({ ...initial, target: { id: "e1" } }, initial), false);
});

test("restorableBackup : copie differente rendue, copie identique ou absente non", () => {
	assert.equal(restorableBackup("agenda:new:i1", initial), null);
	writeFormBackup("agenda:new:i1", initial);
	assert.equal(restorableBackup("agenda:new:i1", initial), null);
	writeFormBackup("agenda:new:i1", { ...initial, v: { ...initial.v, title: "Point" } });
	assert.equal((restorableBackup("agenda:new:i1", initial)?.values as any).v.title, "Point");
});

test("syncFormBackup : ecrit tant que la saisie differe, retire la copie quand elle revient a l'initial", () => {
	syncFormBackup("agenda:new:i1", { ...initial, v: { ...initial.v, title: "Po" } }, initial);
	assert.equal((readFormBackup("agenda:new:i1")?.values as any).v.title, "Po");
	syncFormBackup("agenda:new:i1", { ...initial, v: { ...initial.v, title: "Poi" } }, initial);
	assert.equal((readFormBackup("agenda:new:i1")?.values as any).v.title, "Poi");
	syncFormBackup("agenda:new:i1", initial, initial);
	assert.equal(readFormBackup("agenda:new:i1"), null);
});

test("purge : plus de 7 jours supprime, le reste garde, les autres cles du stockage intactes", () => {
	const now = 100 * DAY;
	writeFormBackup("agenda:new:vieux", { a: 1 }, now - 7 * DAY - 1);
	writeFormBackup("agenda:edit:limite", { a: 1 }, now - 7 * DAY + 1000);
	writeFormBackup("agenda:new:recent", { a: 1 }, now - 1000);
	store.data.set(`${FORM_BACKUP_PREFIX}agenda:new:casse`, "{pas du json");
	store.data.set("ss2i-draft-backup:d1", "{}");
	store.data.set("autre", "x");
	assert.equal(purgeFormBackups(7 * DAY, now), 2);
	assert.equal(readFormBackup("agenda:new:vieux"), null);
	assert.ok(readFormBackup("agenda:edit:limite"));
	assert.ok(readFormBackup("agenda:new:recent"));
	assert.ok(!store.data.has(`${FORM_BACKUP_PREFIX}agenda:new:casse`));
	assert.ok(store.data.has("ss2i-draft-backup:d1") && store.data.has("autre"));
});

test("quota plein : aucune exception, une copie ancienne est purgee pour faire de la place", () => {
	writeFormBackup("agenda:new:vieux", { a: 1 }, 1);
	store.full = true;
	assert.doesNotThrow(() => assert.equal(writeFormBackup("agenda:new:i1", { title: "a" }), false));
	assert.doesNotThrow(() => syncFormBackup("agenda:new:i1", { title: "a" }, { title: "" }));
	assert.doesNotThrow(() => purgeFormBackups());
	assert.equal(readFormBackup("agenda:new:i1"), null);
	assert.equal(readFormBackup("agenda:new:vieux"), null);
});

test("pas de window (rendu serveur) : tout est sans effet", () => {
	const saved = (globalThis as any).window;
	(globalThis as any).window = undefined;
	try {
		assert.equal(writeFormBackup("agenda:new:i1", { a: 1 }), false);
		assert.equal(readFormBackup("agenda:new:i1"), null);
		assert.deepEqual(listFormBackups(), []);
		assert.equal(purgeFormBackups(), 0);
		assert.equal(recentFormBackup(["agenda:new:"]), null);
		removeFormBackup("agenda:new:i1");
	} finally {
		(globalThis as any).window = saved;
	}
});

test("recentFormBackup : la plus recente de moins de 24 h parmi les prefixes demandes", () => {
	const now = 100 * DAY;
	writeFormBackup("agenda:new:i1", { a: 1 }, now - 3 * 3600 * 1000);
	writeFormBackup("agenda:edit:e1", { a: 2 }, now - 1 * 3600 * 1000);
	writeFormBackup("agenda:from-mail:m1", { a: 3 }, now - 60 * 1000);
	writeFormBackup("agenda:edit:vieux", { a: 4 }, now - 25 * 3600 * 1000);
	const hit = recentFormBackup(["agenda:new:", "agenda:edit:"], DAY, now);
	assert.equal(hit?.key, "agenda:edit:e1");
	assert.equal(recentFormBackup(["agenda:new:"], DAY, now)?.key, "agenda:new:i1");
	assert.equal(recentFormBackup(["agenda:edit:vieux"], DAY, now), null);
	assert.equal(recentFormBackup(["inconnu:"], DAY, now), null);
});

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("creation et modification d'evenement : event-editor.tsx utilise la copie locale", () => {
	const src = read("components/outlook-calendar/event-editor.tsx");
	assert.match(src, /from "@\/lib\/form-backup"/);
	assert.match(src, /syncFormBackup\(/);
	assert.match(src, /restorableBackup\(/);
	assert.match(src, /removeFormBackup\(/);
	assert.match(src, /agendaNewKey\(/);
	assert.match(src, /agendaEditKey\(/);
	assert.match(src, /Saisie restaurée depuis ce navigateur/);
});

test("depuis un mail : add-to-agenda.tsx utilise la copie locale", () => {
	const src = read("components/mailbox/default/add-to-agenda.tsx");
	assert.match(src, /from "@\/lib\/form-backup"/);
	assert.match(src, /syncFormBackup\(/);
	assert.match(src, /restorableBackup\(/);
	assert.match(src, /removeFormBackup\(/);
	assert.match(src, /agendaFromMailKey\(/);
	assert.match(src, /Saisie restaurée depuis ce navigateur/);
});

test("page Agenda : copie recente rouverte apres un rechargement, purge des copies anciennes", () => {
	const src = read("components/outlook-calendar/agenda-page.tsx");
	assert.match(src, /recentFormBackup\(/);
	assert.match(src, /purgeFormBackups\(/);
	assert.match(src, /Un événement en cours de saisie a été conservé/);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\nform-backup : tous les tests passent");
