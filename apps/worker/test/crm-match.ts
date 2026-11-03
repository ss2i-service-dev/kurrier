// Regles pures de la section « Clients » (packages/common/src/crm-match.ts) : identites
// pro, adresses exterieures d'un fil (domaines internes et sous-domaines ecartes,
// automates ecartes, messageries grand public gardees pour la CRM), regroupement des
// reponses par societe, URL de la fiche CRM. Aucune base, aucun Redis. Lancement
// (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/crm-match.ts
import assert from "node:assert/strict";
import {
	addressesOf,
	companiesOf,
	crmCompanyUrl,
	externalAddresses,
	htmlToPlainLines,
	isAutomatedAddress,
	quotedHeaderAddresses,
	isProIdentity,
	normalizeEmail,
	parseDomainList,
	DEFAULT_INTERNAL_DOMAINS,
	DEFAULT_PRO_DOMAINS,
} from "../../../packages/common/src/crm-match";

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

const internal = parseDomainList(undefined, DEFAULT_INTERNAL_DOMAINS);
const pro = parseDomainList(undefined, DEFAULT_PRO_DOMAINS);

test("liste de domaines : defaut, espaces, casse, @, doublons", () => {
	assert.deepEqual(internal, ["ss2i-digital.fr", "ss2i-services.fr", "ss2i.ca"]);
	assert.deepEqual(parseDomainList(" A.fr, @b.FR ,a.fr,, ", "x"), ["a.fr", "b.fr"]);
	assert.deepEqual(parseDomainList("   ", "x.fr"), ["x.fr"]);
});

test("identite pro : domaine de la liste, pas une boite perso", () => {
	assert.equal(isProIdentity("samuel@ss2i-digital.fr", pro), true);
	assert.equal(isProIdentity("Hugo@SS2I-Services.fr", pro), true);
	assert.equal(isProIdentity("sam.legros@gmail.com", pro), false);
	assert.equal(isProIdentity("contact@life.olibrio.fr", pro), false);
	assert.equal(isProIdentity("x@ss2i.ca", pro), false);
	assert.equal(isProIdentity(null, pro), false);
});

test("normalisation : casse, espaces, forme « Nom <adresse> », rejet des invalides", () => {
	assert.equal(normalizeEmail("  Julie.Gautron@EspaceAlchimie.com "), "julie.gautron@espacealchimie.com");
	assert.equal(normalizeEmail("Julie <j@a.fr>"), "j@a.fr");
	assert.equal(normalizeEmail("pas-une-adresse"), null);
	assert.equal(normalizeEmail("x@localhost"), null);
	assert.equal(normalizeEmail(""), null);
});

test("adresses d'un champ : AddressObjectJSON, liste de pastilles, texte, groupe", () => {
	assert.deepEqual(
		addressesOf({ value: [{ address: "A@x.fr", name: "A" }, { address: "b@y.fr" }], html: "", text: "" }),
		["a@x.fr", "b@y.fr"],
	);
	assert.deepEqual(addressesOf([{ e: "c@z.fr", n: "C" }]), ["c@z.fr"]);
	assert.deepEqual(addressesOf("d@w.fr, E <e@w.fr>"), ["d@w.fr", "e@w.fr"]);
	assert.deepEqual(addressesOf({ value: [{ name: "equipe", group: [{ address: "g@v.fr" }] }] }), ["g@v.fr"]);
	assert.deepEqual(addressesOf(null), []);
});

test("automates : no-reply et variantes, rebonds, VERP ; pas un humain avec « reply » dans le nom", () => {
	for (const e of [
		"noreply@client.fr", "no-reply@client.fr", "NoReply.Service@client.fr", "donotreply@client.fr",
		"ne-pas-repondre@client.fr", "notifications@github.com", "mailer-daemon@mx.fr", "postmaster@mx.fr",
		"bounce@client.fr", "bounces+123@client.fr", "info.no-reply@client.fr",
		"a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6@bounce.fr",
	]) assert.equal(isAutomatedAddress(e), true, e);
	for (const e of ["replymaster@client.fr", "julie.gautron@espacealchimie.com", "contact@client.fr", "info@client.fr"])
		assert.equal(isAutomatedAddress(e), false, e);
});

test("adresses exterieures d'un fil : internes et sous-domaines ecartes, automates ecartes, gmail garde, doublons", () => {
	const fields = [
		{ value: [{ address: "samuel@ss2i-digital.fr" }] },
		{ value: [{ address: "Julie.Gautron@espacealchimie.com" }, { address: "cerise@cerise2.ss2i-services.fr" }] },
		{ value: [{ address: "jb@ss2i-digital.fr" }, { address: "mhavsali@gmail.com" }] },
		{ value: [{ address: "noreply@espacealchimie.com" }, { address: "julie.gautron@espacealchimie.com" }] },
		{ value: [{ address: "x@mail.ss2i.ca" }] },
		null,
	];
	assert.deepEqual(externalAddresses(fields, internal), ["julie.gautron@espacealchimie.com", "mhavsali@gmail.com"]);
	assert.deepEqual(externalAddresses([{ value: [{ address: "samuel@ss2i-digital.fr" }] }], internal), []);
});

test("societes d'un fil : une par id, adresse exacte prime sur domaine, non rattachees ignorees", () => {
	const companies = companiesOf([
		{ email: "a@alchimie.com", matched: true, matchedBy: "domain", companyId: 12, companyName: "ALCHIMIE" },
		{ email: "b@alchimie.com", matched: true, matchedBy: "email", companyId: 12, companyName: "ALCHIMIE" },
		{ email: "c@delvie.fr", matched: true, matchedBy: "email", companyId: 7, companyName: "SARL DELVIE" },
		{ email: "d@gmail.com", matched: false, matchedBy: null, companyId: null, companyName: null },
		{ email: "e@x.fr", matched: true, matchedBy: "domain", companyId: null, companyName: null },
	]);
	assert.deepEqual(companies, [
		{ companyId: 7, companyName: "SARL DELVIE", matchedBy: "email" },
		{ companyId: 12, companyName: "ALCHIMIE", matchedBy: "email" },
	]);
	assert.deepEqual(companiesOf([]), []);
});

test("URL de la fiche CRM : defaut, base sans barre finale", () => {
	assert.equal(crmCompanyUrl(undefined, 12), "https://crm.ss2i-services.fr/companies/12");
	assert.equal(crmCompanyUrl("https://crm.test/", 12), "https://crm.test/companies/12");
});

test("en-tetes d'un message transfere dans le corps (Outlook FR, Gmail EN, HTML)", () => {
	const outlook = "Bien cordialement,\nHugo\ncontact@ss2i-services.fr\n\nDe : Sylvain Darroy <s.darroy@groupe-libaud.fr>\nEnvoy\u00e9 : lundi 2 novembre 2026 17:13\n\u00c0 : Hugo Mayonobe <hugo@ss2i-services.fr>\nCc : a@x.fr; B <b@y.fr>\nObjet : SOAP LIBAUD\n\nvoir support@editeur.com";
	assert.deepEqual(quotedHeaderAddresses(outlook), ["s.darroy@groupe-libaud.fr", "hugo@ss2i-services.fr", "a@x.fr", "b@y.fr"]);
	assert.deepEqual(quotedHeaderAddresses("---------- Forwarded message ---------\nFrom: Jane <jane@client.com>\nTo: me@ss2i-digital.fr"), ["jane@client.com", "me@ss2i-digital.fr"]);
	assert.deepEqual(quotedHeaderAddresses("> *From:* x@c.fr"), ["x@c.fr"]);
	const html = "<p>Bonjour</p><div><b>De&nbsp;:</b> Sylvain Darroy &lt;s.darroy@groupe-libaud.fr&gt;<br><b>Objet :</b> SOAP</div>";
	assert.deepEqual(quotedHeaderAddresses(htmlToPlainLines(html)), ["s.darroy@groupe-libaud.fr"]);
	assert.deepEqual(
		externalAddresses([{ value: [{ address: "hugo@ss2i-services.fr" }] }, quotedHeaderAddresses(outlook)], DEFAULT_INTERNAL_DOMAINS.split(",")),
		["s.darroy@groupe-libaud.fr", "a@x.fr", "b@y.fr"],
	);
	assert.deepEqual(quotedHeaderAddresses(null), []);
});

if (failures) {
	console.error(`${failures} failure(s)`);
	process.exit(1);
}
console.log("all crm-match tests passed");
