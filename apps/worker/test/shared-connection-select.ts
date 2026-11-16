// Connexion IMAP de commandes partagee : une ouverture de dossier ne doit jamais rebasculer la
// selection pendant qu'un autre traitement tient le verrou d'un dossier.
// Incident du 30/10 et du 04/11/2026 : pendant la synchro de Drafts (verrou pris, plage UID 1:17
// calculee sur Drafts), la decouverte des dossiers a fait mailboxOpen sans verrou ; le FETCH est
// parti sur INBOX, les messages INBOX portant ces UID ont ete pris pour des deplacements vers
// Drafts et chacun a emporte tout son fil (jb : 30 messages, hugo : 19).
// Sans base. Depuis la racine : node_modules/.bin/tsx apps/worker/test/shared-connection-select.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openMailboxLocked, selectedIs } from "../lib/imap/imap-open-locked";

let failures = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

// Faux ImapFlow : file de verrous exclusive, comme ImapFlow (getMailboxLock attend la liberation
// du verrou precedent et selectionne le dossier demande).
class FakeClient {
	mailbox: { path: string; uidNext: number; uidValidity: number } | false = false;
	private queue: Promise<void> = Promise.resolve();
	uidNext: Record<string, number> = { INBOX: 10020, Drafts: 18, Archive: 58 };
	async mailboxOpen(path: string) {
		this.mailbox = { path, uidNext: this.uidNext[path] ?? 1, uidValidity: 1 };
		return this.mailbox;
	}
	async getMailboxLock(path: string) {
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const previous = this.queue;
		this.queue = previous.then(() => held);
		await previous;
		if (!this.mailbox || this.mailbox.path !== path) await this.mailboxOpen(path);
		return { release };
	}
}
const tick = () => new Promise((r) => setTimeout(r, 5));

(async () => {
	await test("openMailboxLocked attend la fin de la passe Drafts avant d'ouvrir un autre dossier", async () => {
		const client = new FakeClient();
		const lock = await client.getMailboxLock("Drafts");
		const opening = openMailboxLocked(client as any, "Archive");
		await tick();
		assert.ok(selectedIs(client as any, "Drafts"), "la selection est restee sur Drafts pendant la passe");
		lock.release();
		const box = await opening;
		assert.equal(box.path, "Archive");
		assert.equal(box.uidNext, 58);
	});
	
	await test("un mailboxOpen sans verrou est bien detecte par selectedIs (garde de syncMailbox)", async () => {
		const client = new FakeClient();
		const lock = await client.getMailboxLock("Drafts");
		await client.mailboxOpen("INBOX"); // l'ancien comportement de la decouverte
		assert.equal(selectedIs(client as any, "Drafts"), false);
		lock.release();
	});
	
	await test("plus aucun mailboxOpen sans verrou dans la decouverte et la creation de dossier", () => {
		for (const f of [
			"lib/imap/backfill/discover/discover-mailboxes.ts",
			"lib/imap/backfill/discover/discover-trash.ts",
			"lib/imap/backfill/discover/discover-archive.ts",
			"lib/imap/imap-new-folder.ts",
		]) {
			assert.doesNotMatch(src(f), /client\.mailboxOpen\(/, f);
			assert.match(src(f), /openMailboxLocked\(client,/, f);
		}
	});
	
	await test("le rattrapage d'un dossier tient le verrou du dossier", () => {
		const s = src("lib/imap/backfill/backfill-full.ts");
		assert.match(s, /getMailboxLock\(opts\.path, \{ readOnly: true \}\)[\s\S]*backfillMailboxFullLocked\(opts\)/);
	});
	
	await test("syncMailbox abandonne la passe si la selection n'est plus le dossier attendu", () => {
		const s = src("lib/imap/imap-sync-mailbox.ts");
		assert.match(s, /if \(wrongFolder\(\)\) return;\n\t\tconst currentTop/);
		assert.match(s, /if \(wrongFolder\(\)\) return;\n\t\t\tfor await/);
		assert.match(s, /if \(aborted \|\| wrongFolder\(\)\)/);
		assert.match(s, /if \(aborted\) return;\n\t\t\tif \(maxUid > lastSeen\)/, "curseur non avance");
	});
	
	await test("deltaFetch ne prend pas un message vu dans Drafts pour un deplacement", () => {
		const s = src("lib/imap/imap-delta-fetch.ts");
		const guard = s.indexOf('row.kind === "drafts"');
		assert.ok(guard > 0);
		assert.ok(guard < s.indexOf("Move detected"), "garde avant la detection de deplacement");
	});
	
	await test("Brouillons refuse comme destination d'un deplacement (worker et web)", () => {
		assert.match(src("lib/imap/imap-move.ts"), /destMailboxRow\?\.kind === "drafts"/);
		assert.match(readFileSync(join(__dirname, "../../web/lib/actions/mailbox.ts"), "utf8"), /\(to as any\)\.kind === "drafts"\) return;/);
	});
	
	if (failures) {
		console.log(`\n${failures} test(s) en echec`);
		process.exit(1);
	}
	console.log("\nshared-connection-select : tout est vert");
})();
