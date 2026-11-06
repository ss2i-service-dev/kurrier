// Un meme mail affiche deux fois dans un fil. Samuel le 06/11/2026 : « je vois deux fois le
// meme mail en tete de mail. Ca n'a aucun putain de foutu sens ». Fil c04305b7 (Postal2,
// reponse a Maud de 12:09) : la reponse envoyee existe en base deux fois avec le meme
// Message-ID, la copie du dossier Sent et la copie recue dans l'Inbox (dev@ en copie
// arrive chez samuel@). fetchWebMailThreadDetail renvoie les deux, le fil les affichait.
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/thread-dedupe.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dedupeThreadMessages } from "../lib/thread-dedupe";

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

// Reproduction du fil c04305b7 (ordre chronologique, comme fetchWebMailThreadDetail).
const fil = [
	{ id: "4dd6", messageId: "<e6de2678@rp.postal2>", mailboxId: "archive" },
	{ id: "e9e8", messageId: "<90a40910@ss2i-digital.fr>", mailboxId: "sent" },
	{ id: "35d8", messageId: "<DB8PR01@exchangelabs.com>", mailboxId: "inbox" },
	{ id: "8fad", messageId: "<f9903c06@ss2i-digital.fr>", mailboxId: "sent" },
	{ id: "60fb", messageId: "<f9903c06@ss2i-digital.fr>", mailboxId: "inbox" },
];

test("fil c04305b7 : la reponse a Maud n'apparait qu'une fois", () => {
	const ids = dedupeThreadMessages(fil).map((m) => m.id);
	assert.deepEqual(ids, ["4dd6", "e9e8", "35d8", "60fb"]);
});

test("garde la copie la plus recente (celle qui decide du dossier du fil)", () => {
	const out = dedupeThreadMessages(fil);
	assert.equal(out[out.length - 1].mailboxId, "inbox");
});

test("Message-ID compare sans casse ni espaces ni chevrons", () => {
	const out = dedupeThreadMessages([
		{ id: "a", messageId: " <ABC@x.fr> " },
		{ id: "b", messageId: "abc@X.FR" },
	]);
	assert.deepEqual(out.map((m) => m.id), ["b"]);
});

test("Message-ID vide ou absent : jamais fusionne", () => {
	const out = dedupeThreadMessages([
		{ id: "a", messageId: "" },
		{ id: "b", messageId: "" },
		{ id: "c", messageId: null },
		{ id: "d" },
	]);
	assert.deepEqual(out.map((m) => m.id), ["a", "b", "c", "d"]);
});

test("fil sans doublon : inchange, ordre garde", () => {
	const ids = fil.slice(0, 4);
	assert.deepEqual(dedupeThreadMessages(ids), ids);
});

// Cablage : les trois rendus du fil (classique direct, classique en navigation douce,
// nouvelle interface) affichent la liste dedoublonnee.
const root = join(__dirname, "..");
const mailDir = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/[mailboxSlug]";
for (const file of [
	`${mailDir}/threads/[threadId]/page.tsx`,
	`${mailDir}/@thread/(.)threads/[threadId]/page.tsx`,
	"components/k/thread-page.tsx",
]) {
	test(`cablage : ${file}`, () => {
		const src = readFileSync(join(root, file), "utf8");
		assert.match(src, /dedupeThreadMessages\(/);
	});
}

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les tests passent");
