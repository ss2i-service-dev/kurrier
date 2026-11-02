// Blocage d'expediteurs (packages/common/src/sender-block.ts) : correspondance adresse,
// domaine et sous-domaines, domaines grand public, domaines de l'utilisateur. Aucune base.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/sender-block.ts
import assert from "node:assert/strict";
import { blockOptionsFor, emailDomain, isBlockedSender, isFreeMailDomain, isOwnDomain, normalizeAddress, normalizeDomain } from "../../../packages/common/src/sender-block";

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

const domain = [{ kind: "domain" as const, value: "tdsynnex.com" }];
const address = [{ kind: "address" as const, value: "Pub@Exemple.fr" }];

test("domaine exact et sous-domaines", () => {
	assert.equal(isBlockedSender("a@tdsynnex.com", domain), true);
	assert.equal(isBlockedSender("A@MAIL.TDSYNNEX.COM", domain), true);
	assert.equal(isBlockedSender("a@eu.mail.tdsynnex.com", domain), true);
});

test("pas de faux positif de suffixe", () => {
	assert.equal(isBlockedSender("a@nottdsynnex.com", domain), false);
	assert.equal(isBlockedSender("a@tdsynnex.com.evil.org", domain), false);
	assert.equal(isBlockedSender("tdsynnex.com@autre.org", domain), false);
});

test("adresse exacte, casse ignoree, forme « Nom <adresse> »", () => {
	assert.equal(isBlockedSender("pub@exemple.fr", address), true);
	assert.equal(isBlockedSender("Pub <PUB@exemple.fr>", address), true);
	assert.equal(isBlockedSender("autre@exemple.fr", address), false);
	assert.equal(isBlockedSender("", address), false);
	assert.equal(isBlockedSender(null, domain), false);
});

test("normalisation", () => {
	assert.equal(normalizeDomain(" @*.TDSynnex.com. "), "tdsynnex.com");
	assert.equal(normalizeDomain("*.x.org"), "x.org");
	assert.equal(emailDomain("Nom <a@Mail.X.org>"), "mail.x.org");
	assert.equal(normalizeAddress("Nom <A@B.fr>"), "a@b.fr");
});

test("domaines grand public", () => {
	for (const d of ["gmail.com", "outlook.com", "outlook.fr", "hotmail.com", "hotmail.fr", "hotmail.co.uk", "yahoo.com", "yahoo.fr", "orange.fr", "free.fr", "icloud.com", "live.com", "live.fr"]) {
		assert.equal(isFreeMailDomain(d), true, d);
	}
	for (const d of ["tdsynnex.com", "ss2i-digital.fr", "mondejaubureau.fr", "outlook-tools.com", "hotmail.evil.org"]) {
		assert.equal(isFreeMailDomain(d), false, d);
	}
});

test("domaines de l'utilisateur", () => {
	const own = ["ss2i-digital.fr", "ss2i.ca"];
	assert.equal(isOwnDomain("ss2i-digital.fr", own), true);
	assert.equal(isOwnDomain("mail.ss2i.ca", own), true);
	assert.equal(isOwnDomain("tdsynnex.com", own), false);
});

test("options proposees : domaine seulement s'il est bloquable", () => {
	const own = ["ss2i-digital.fr"];
	assert.deepEqual(blockOptionsFor("Pro <v@tdsynnex.com>", own), { address: "v@tdsynnex.com", domain: "tdsynnex.com" });
	assert.deepEqual(blockOptionsFor("x@gmail.com", own), { address: "x@gmail.com", domain: null });
	assert.deepEqual(blockOptionsFor("x@ss2i-digital.fr", own), { address: "x@ss2i-digital.fr", domain: null });
	assert.deepEqual(blockOptionsFor("x@hotmail.fr", own), { address: "x@hotmail.fr", domain: null });
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
