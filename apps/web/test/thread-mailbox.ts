// Fil ouvert depuis un dossier client (route interceptee @thread/(.)threads avec
// mailboxSlug = "clients"). Samuel le 05/11/2026 : « je suis dans un dossier virtuel client,
// [...] je clique dessus, ca me ramene a la liste de tous les mails sans ouvrir le mail ».
// Cause : fetchMailbox redirige vers l'Inbox sur un dossier inconnu (URL jamais bloquante,
// 04/11) ; fetchThreadMailbox attendait encore l'exception « Mailbox not found ».
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/thread-mailbox.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pickThreadMailboxSlug } from "../lib/thread-mailbox-pick";

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

const list = [
	{ id: "m-inbox", slug: "inbox" },
	{ id: "m-archive", slug: "archive" },
];

test("dossier du message le plus recent du fil", () => {
	assert.equal(pickThreadMailboxSlug(list, [{ mailboxId: "m-inbox" }, { mailboxId: "m-archive" }]), "archive");
});
test("messages d'un dossier etranger ignores", () => {
	assert.equal(pickThreadMailboxSlug(list, [{ mailboxId: "m-inbox" }, { mailboxId: "autre" }]), "inbox");
	assert.equal(pickThreadMailboxSlug(list, [{ mailboxId: null }]), null);
});

const src = readFileSync(join(__dirname, "../lib/thread-mailbox.ts"), "utf8");
test("le dossier de l'URL est verifie dans la liste avant fetchMailbox (pas de repli sur exception)", () => {
	assert.ok(!/Mailbox not found/.test(src.replace(/^\s*\/\/.*$/gm, "")), "repli sur l'exception « Mailbox not found » : fetchMailbox redirige, il ne la leve plus");
	const check = src.indexOf("mailboxList.some(");
	const call = src.indexOf("fetchMailbox(identityPublicId, mailboxSlug)");
	assert.ok(check > 0 && call > check, "fetchMailbox(identityPublicId, mailboxSlug) doit etre garde par mailboxList.some(...)");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
