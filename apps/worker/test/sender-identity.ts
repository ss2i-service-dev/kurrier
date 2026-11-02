// Identite d'envoi d'une reponse MCP (lib/mcp/sender-identity.ts) : un message envoye de
// A vers B, deux identites du meme utilisateur, est une seule ligne `messages` qui passe
// du Sent de A a l'Inbox de B (et retour) au gre des synchronisations : la reponse doit
// partir de B (destinataire) a chaque execution, quel que soit le dossier du moment.
// Aucune base. Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/sender-identity.ts
import assert from "node:assert/strict";
import { pickSenderIdentity } from "../lib/mcp/sender-identity";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err)}`);
	}
};

const A = { id: "00478dd6-d45b-4460-a689-4debb414a74a", value: "sam.legros@gmail.com" };
const B = { id: "93b3ccfd-d946-4133-946b-4a8284254bfe", value: "samuel@ss2i-digital.fr" };
const C = { id: "c0ffee00-0000-4000-8000-000000000003", value: "autre@ss2i.ca" };

// Message envoye par A a B : From A, To B.
const message = {
	from: { value: [{ address: A.value, name: "Sam (Gmail)" }] },
	to: { value: [{ address: "Samuel@SS2i-digital.fr", name: "Samuel" }] },
	cc: { value: [] },
	deliveredTo: null,
};

const shuffle = <T,>(arr: T[], seed: number) => {
	const a = [...arr];
	let s = seed;
	for (let i = a.length - 1; i > 0; i--) {
		s = (s * 1103515245 + 12345) % 2147483648;
		const j = s % (i + 1);
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
};

test("meme message dans Sent de A et Inbox de B, To = B : la reponse part de B, a chaque execution", () => {
	for (let run = 0; run < 100; run++) {
		// La ligne est tantot dans le dossier de A, tantot dans celui de B ; l'ordre des
		// identites varie aussi.
		const mailboxIdentityId = run % 2 ? A.id : B.id;
		const r = pickSenderIdentity({
			identities: shuffle([A, B, C], run + 1),
			message,
			mailboxIdentityId,
		});
		assert.equal(r.identity.id, B.id, `run ${run}, dossier de ${mailboxIdentityId === A.id ? "A" : "B"}`);
		assert.equal(r.reason, "recipient");
	}
});

test("parametre identity explicite : prioritaire, meme si le message est adresse a B", () => {
	const r = pickSenderIdentity({ identities: [A, B], message, explicit: A, mailboxIdentityId: B.id });
	assert.equal(r.identity.id, A.id);
	assert.equal(r.reason, "explicit");
});

test("destinataire en Cc puis Delivered-To, To avant Cc", () => {
	const cc = pickSenderIdentity({
		identities: [A, B, C],
		message: { to: { value: [{ address: "client@example.com" }] }, cc: { value: [{ address: C.value }] } },
		mailboxIdentityId: A.id,
	});
	assert.equal(cc.identity.id, C.id);
	const delivered = pickSenderIdentity({
		identities: [A, B, C],
		message: { to: { value: [{ address: "liste@example.com" }] }, deliveredTo: B.value },
		mailboxIdentityId: A.id,
	});
	assert.equal(delivered.identity.id, B.id);
	const both = pickSenderIdentity({
		identities: [A, B, C],
		message: { to: { value: [{ address: C.value }] }, cc: { value: [{ address: B.value }] } },
		mailboxIdentityId: A.id,
	});
	assert.equal(both.identity.id, C.id);
});

test("aucune adresse propre dans les destinataires : identite du dossier", () => {
	const r = pickSenderIdentity({
		identities: [A, B],
		message: { to: { value: [{ address: "client@example.com" }] } },
		mailboxIdentityId: A.id,
	});
	assert.equal(r.identity.id, A.id);
	assert.equal(r.reason, "mailbox");
	// Adresses sous forme de chaine (anciens enregistrements).
	const s = pickSenderIdentity({ identities: [A, B], message: { to: "x@y, samuel@ss2i-digital.fr" }, mailboxIdentityId: A.id });
	assert.equal(s.identity.id, B.id);
});

test("rien ne correspond : erreur explicite qui liste les identites", () => {
	assert.throws(
		() => pickSenderIdentity({ identities: [A, B], message: { to: { value: [{ address: "x@y" }] } }, mailboxIdentityId: "inconnu" }),
		/pass 'identity' \(sam\.legros@gmail\.com, samuel@ss2i-digital\.fr\)/,
	);
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
