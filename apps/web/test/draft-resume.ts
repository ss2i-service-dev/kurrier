// Ce qu'on tape ne disparait jamais de l'ecran (Samuel le 10/11, onglet recharge de force
// pendant une reponse : « a l'ouverture je ne voyais plus mon texte, puis il est revenu »).
// L'editeur qui s'ouvre sur un brouillon ou sur une reponse reprend la copie locale
// (lib/draft-backup.ts) quand elle est plus recente que le serveur.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/draft-resume.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backupToDraftRow, pickBackupForEditor } from "../lib/draft-resume";

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

const NOW = 1_000_000_000;
const backup = (over: Record<string, any> = {}) => ({
	v: 1 as const,
	id: "b1",
	identityPublicId: "ident",
	draftMessageId: "d1" as string | null,
	payload: { mode: "reply", originalMessageId: "m1", subject: "Re: x", html: "<p>texte</p>" } as Record<string, string | null>,
	key: "k2",
	savedKey: "k1" as string | null,
	sentAt: null as number | null,
	updatedAt: NOW - 60_000,
	...over,
});
const dead = () => 0;
const forDraft = (over: Record<string, any> = {}) => ({
	draftMessageId: "d1",
	draftUpdatedAt: NOW - 120_000,
	originalMessageId: null,
	mode: null,
	now: NOW,
	aliveAt: dead,
	...over,
});
const forReply = (over: Record<string, any> = {}) => ({
	draftMessageId: null,
	draftUpdatedAt: null,
	originalMessageId: "m1",
	mode: "reply",
	now: NOW,
	aliveAt: dead,
	...over,
});

test("copie plus recente que le serveur : reprise", () => {
	const b = backup();
	assert.equal(pickBackupForEditor([b], forDraft()), b);
});

test("copie deja enregistree (key === savedKey) : pas de reprise", () => {
	assert.equal(pickBackupForEditor([backup({ key: "k1", savedKey: "k1" })], forDraft()), null);
});

test("copie jamais confirmee par le serveur (savedKey absent) : reprise", () => {
	const b = backup({ savedKey: null });
	assert.equal(pickBackupForEditor([b], forDraft()), b);
});

test("copie envoyee : jamais reprise", () => {
	assert.equal(pickBackupForEditor([backup({ sentAt: NOW - 5_000 })], forDraft()), null);
});

test("editeur vivant ailleurs (battement de moins de 10 s) : pas de reprise", () => {
	assert.equal(pickBackupForEditor([backup()], forDraft({ aliveAt: () => NOW - 3_000 })), null);
});

test("battement ancien (onglet mort ou recharge) : reprise", () => {
	const b = backup();
	assert.equal(pickBackupForEditor([b], forDraft({ aliveAt: () => NOW - 30_000 })), b);
});

test("brouillon du serveur modifie bien apres la copie : le serveur est plus recent, pas de reprise", () => {
	assert.equal(pickBackupForEditor([backup()], forDraft({ draftUpdatedAt: NOW + 10 * 60_000 })), null);
});

test("ecart d'horloge client/serveur de quelques secondes : la copie reste reprise", () => {
	const b = backup();
	assert.equal(pickBackupForEditor([b], forDraft({ draftUpdatedAt: NOW - 60_000 + 5_000 })), b);
});

test("copie d'un autre brouillon : pas de reprise", () => {
	assert.equal(pickBackupForEditor([backup({ draftMessageId: "d2" })], forDraft()), null);
});

test("reponse jamais enregistree, retrouvee par originalMessageId et mode", () => {
	const b = backup({ draftMessageId: null, savedKey: null });
	assert.equal(pickBackupForEditor([b], forReply()), b);
});

test("reponse a tous et reponse sont le meme mode ; transfert est un autre mode", () => {
	const b = backup({ draftMessageId: null, savedKey: null });
	assert.equal(pickBackupForEditor([b], forReply({ mode: "replyAll" })), b);
	assert.equal(pickBackupForEditor([b], forReply({ mode: "forward" })), null);
});

test("reponse a un autre message : pas de reprise", () => {
	const b = backup({ draftMessageId: null, savedKey: null });
	assert.equal(pickBackupForEditor([b], forReply({ originalMessageId: "m2" })), null);
});

test("transfert jamais enregistre, retrouve par originalMessageId et mode", () => {
	const b = backup({ draftMessageId: null, savedKey: null, payload: { mode: "forward", originalMessageId: "m1" } });
	assert.equal(pickBackupForEditor([b], forReply({ mode: "forward" })), b);
});

test("reponse sans brouillon : une copie liee a un brouillon du serveur n'est pas reprise (c'est le brouillon qui s'ouvre)", () => {
	assert.equal(pickBackupForEditor([backup({ draftMessageId: "d1" })], forReply()), null);
});

test("nouveau message sans original ni brouillon : rien a reprendre", () => {
	const b = backup({ draftMessageId: null, savedKey: null, payload: { mode: "compose", originalMessageId: null } });
	assert.equal(pickBackupForEditor([b], forReply({ originalMessageId: null, mode: "compose" })), null);
});

test("plusieurs copies candidates : la plus recente", () => {
	const old = backup({ id: "old", updatedAt: NOW - 90_000 });
	const recent = backup({ id: "recent", updatedAt: NOW - 20_000 });
	assert.equal(pickBackupForEditor([old, recent], forDraft()), recent);
	assert.equal(pickBackupForEditor([recent, old], forDraft()), recent);
});

test("copie v1 existante (sans champ ajoute) : lisible, rien n'est exige de plus", () => {
	const b = backup();
	assert.equal(b.v, 1);
	assert.ok(pickBackupForEditor([b], forDraft()));
});

test("backupToDraftRow : champs de l'editeur reconstruits depuis la copie, sans toucher au brouillon du serveur", () => {
	const base = { id: "d1", subject: "ancien", html: "<p>ancien</p>", to: { value: [] }, metaData: { draft: { revision: 3, mode: "reply" }, imap: { uid: 4 } } };
	const b = backup({
		payload: {
			mode: "reply",
			originalMessageId: "m1",
			to: 'Jean Dupont <jean@x.fr>, marie@x.fr',
			cc: "paul@x.fr",
			bcc: "",
			subject: "Re: nouveau",
			html: "<p>nouveau</p>",
			attachments: JSON.stringify([{ path: "p", filenameOriginal: "a.pdf" }]),
			includeSignature: "false",
			quoteScope: "thread",
			quoteMode: "custom",
			quoteHtml: "<p>cite</p>",
		},
	});
	const row: any = backupToDraftRow(b, base as any);
	assert.equal(row.id, "d1");
	assert.equal(row.subject, "Re: nouveau");
	assert.equal(row.html, "<p>nouveau</p>");
	assert.deepEqual(row.to.value, [{ name: "Jean Dupont", address: "jean@x.fr" }, { name: "", address: "marie@x.fr" }]);
	assert.deepEqual(row.cc.value, [{ name: "", address: "paul@x.fr" }]);
	assert.deepEqual(row.bcc.value, []);
	const meta = row.metaData.draft;
	assert.equal(meta.mode, "reply");
	assert.equal(meta.revision, 3);
	assert.equal(meta.includeSignature, false);
	assert.equal(meta.quoteScope, "thread");
	assert.equal(meta.quoteMode, "custom");
	assert.equal(meta.quoteHtml, "<p>cite</p>");
	assert.deepEqual(meta.attachments, [{ path: "p", filenameOriginal: "a.pdf" }]);
	assert.deepEqual(row.metaData.imap, { uid: 4 });
	assert.equal((base.metaData.draft as any).quoteScope, undefined);
});

test("backupToDraftRow sans brouillon serveur : ligne synthetique (id vide, transfert, signature par defaut)", () => {
	const row: any = backupToDraftRow(
		backup({ draftMessageId: null, payload: { mode: "forward", originalMessageId: "m1", subject: "Fwd: x", html: "<p>t</p>", attachments: "[]" } }),
		null,
	);
	assert.equal(row.id, "");
	assert.equal(row.metaData.draft.mode, "forward");
	assert.deepEqual(row.metaData.draft.attachments, []);
	assert.equal(row.metaData.draft.includeSignature, true);
});

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("editeur : choisit la copie avant le premier rendu, reprend son identifiant et pose le battement tout de suite", () => {
	const src = read("components/mailbox/default/editor/email-editor.tsx");
	assert.match(src, /pickBackupForEditor\(/);
	assert.match(src, /useRef<string>\(resume\?\.id \?\? newBackupId\(\)\)/);
	assert.match(src, /touchAlive\(resume\.id\)/);
	assert.match(src, /Texte restauré depuis ce navigateur/);
});

test("editeur : un onglet qui se ferme ou recharge libere son battement (la copie est reprise tout de suite)", () => {
	assert.match(read("components/mailbox/default/editor/email-editor.tsx"), /clearAlive\(backupId\.current\)/);
});

if (failures) {
	console.log(`\n${failures} test(s) en echec`);
	process.exit(1);
}
console.log("\ndraft-resume : tous les tests passent");
