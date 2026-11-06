// « Répondre avec Lore » depuis un fil (OI 10288) : requête envoyée à Lore (forme du contrat,
// ordre, coupe à 60 messages et ~12 000 caractères, citations retirées, consigne), appel HTTP
// sur des fetch simulés (en-têtes, réponse, erreurs affichées à l'utilisateur), corps et
// destinataires du brouillon, et câblage : bouton monté dans les deux interfaces, action
// serveur sans export interne, Ctrl+Entrée jamais « Send » depuis la fenêtre de consigne.
// Aucune base, aucun réseau. Avec LORE_URL, LORE_APP_TOKEN et LORE_ACT_AS dans
// l'environnement, un essai réel contre Lore en plus. Ce test est lancé par Dockerfile.web
// avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/lore-reply.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	LORE_MAX_CHARS_PER_MESSAGE,
	LORE_MAX_INSTRUCTION,
	LORE_MAX_MESSAGES,
	LORE_REPLY_PATH,
	LoreError,
	type LoreThreadMessage,
	clipLoreText,
	loreActAs,
	loreConfigMissing,
	loreDraftBody,
	loreDraftRecipients,
	loreReplyRequest,
	loreReplySubject,
	requestLoreReply,
} from "../../../packages/common/src/lore-reply";

let failures = 0;
const test = async (label: string, fn: () => unknown) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`ECHEC ${label}\n      ${String(err?.message ?? err).split("\n").join("\n      ")}`);
	}
};

const msg = (i: number, text: string, extra: Partial<LoreThreadMessage> = {}): LoreThreadMessage => ({
	from: `Client ${i} <c${i}@client.fr>`,
	to: ["Samuel LEGROS <samuel@ss2i-digital.fr>"],
	cc: [],
	date: `2026-11-0${(i % 9) + 1}T09:00:00.000Z`,
	text,
	...extra,
});

const rejects = async (p: Promise<unknown>, expected: string | RegExp) => {
	try {
		await p;
	} catch (err: any) {
		assert.ok(err instanceof LoreError, `LoreError attendue, recu ${err?.constructor?.name} : ${err?.message}`);
		if (typeof expected === "string") assert.equal(err.message, expected);
		else assert.match(err.message, expected);
		return;
	}
	throw new Error("aucune erreur levee");
};

const fakeFetch = (status: number, body: string, seen?: { url?: string; init?: RequestInit }) =>
	(async (url: any, init: any) => {
		if (seen) {
			seen.url = String(url);
			seen.init = init;
		}
		return new Response(body, { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;

const cfg = (fetchImpl: typeof fetch, extra: object = {}) => ({
	url: "https://lore.example.test/",
	token: " jeton ",
	actAs: "Samuel@SS2i-Digital.fr",
	fetchImpl,
	...extra,
});

const ok200 = JSON.stringify({
	body_text: "Bonjour Madame,\n\nMerci pour votre retour.\nBien cordialement,",
	body_html: "<p>Bonjour Madame,</p>",
	model: "claude-test",
	sources: [{ title: "Fiche client", url: "https://crm.example/1" }, { title: "", url: "" }],
});

async function main() {
	// --- Requete -------------------------------------------------------------------------
	await test("act-as : identite pro du fil, sinon premiere identite pro, sinon compte", () => {
	const pro = ["ss2i-digital.fr", "ss2i-services.fr"];
	assert.equal(loreActAs({ accountEmail: "samuel@ss2i.ca", threadIdentity: "contact@life.olibrio.fr", identities: ["contact@life.olibrio.fr", "Samuel@SS2i-digital.fr", "sam.legros@gmail.com"], proDomains: pro }), "samuel@ss2i-digital.fr");
	assert.equal(loreActAs({ accountEmail: "samuel@ss2i.ca", threadIdentity: "hugo@ss2i-services.fr", identities: ["samuel@ss2i-digital.fr"], proDomains: pro }), "hugo@ss2i-services.fr");
	assert.equal(loreActAs({ accountEmail: "Jb@ss2i.ca", threadIdentity: "x@gmail.com", identities: ["x@gmail.com"], proDomains: pro }), "jb@ss2i.ca");
});

await test("requete : forme du contrat, boite en minuscules, locale fr, sans consigne", () => {
		const r = loreReplyRequest({
			mailbox: " Samuel@SS2i-Digital.fr ",
			subject: "Devis",
			messages: [msg(1, "Bonjour, pouvez-vous chiffrer ?")],
			crmCompanyIds: [955, 955, 12],
		});
		assert.deepEqual(Object.keys(r).sort(), ["crm_company_ids", "locale", "mailbox", "messages", "subject"]);
		assert.equal(r.mailbox, "samuel@ss2i-digital.fr");
		assert.equal(r.locale, "fr");
		assert.deepEqual(r.crm_company_ids, [955, 12]);
		assert.deepEqual(r.messages[0], {
			from: "Client 1 <c1@client.fr>",
			to: ["Samuel LEGROS <samuel@ss2i-digital.fr>"],
			cc: [],
			date: "2026-11-02T09:00:00.000Z",
			text: "Bonjour, pouvez-vous chiffrer ?",
		});
	});

	await test("requete : consigne rognee, coupee a LORE_MAX_INSTRUCTION, absente si vide", () => {
		const base = { mailbox: "a@b.fr", subject: "x", messages: [msg(1, "t")] };
		assert.equal(loreReplyRequest({ ...base, instruction: "  accepter mardi  " }).instruction, "accepter mardi");
		assert.equal(loreReplyRequest({ ...base, instruction: "x".repeat(5000) }).instruction?.length, LORE_MAX_INSTRUCTION);
		assert.ok(!("instruction" in loreReplyRequest({ ...base, instruction: "   " })));
		assert.ok(!("instruction" in loreReplyRequest({ ...base, instruction: null })));
		assert.deepEqual(loreReplyRequest(base).crm_company_ids, []);
		assert.equal(loreReplyRequest({ ...base, subject: "  " }).subject, "(sans objet)");
	});

	await test("requete : citations retirees a partir du 2e message, le 1er les garde (transfert)", () => {
		const first = "Pour info.\n\n-----Message d'origine-----\nDe : Client <c@client.fr>\nLe devis est en piece jointe.";
		const second = "Bien recu, merci.\n\nLe 3 nov. 2026, Client a écrit :\n> Le devis est en piece jointe.";
		const third = "<p>Je valide.</p><blockquote>ancien</blockquote>";
		const r = loreReplyRequest({
			mailbox: "a@b.fr",
			subject: "TR: devis",
			messages: [msg(1, first), msg(2, second), msg(3, "", { html: third })],
		});
		assert.equal(r.messages[0].text, first.trim());
		assert.equal(r.messages[1].text, "Bien recu, merci.");
		assert.match(r.messages[2].text, /Je valide\./);
	});

	await test("requete : pieces jointes nommees, message vide remplace", () => {
		const r = loreReplyRequest({
			mailbox: "a@b.fr",
			subject: "x",
			messages: [msg(1, "Voici le devis.", { attachments: ["devis.pdf", "plan.png"] }), msg(2, "", { attachments: [] })],
		});
		assert.equal(r.messages[0].text, "Voici le devis.\n\n[Pièces jointes : devis.pdf, plan.png]");
		assert.equal(r.messages[1].text, "(message sans texte)");
	});

	await test("requete : au plus 60 messages, les plus recents, le dernier reste celui auquel on repond", () => {
		const list = Array.from({ length: 75 }, (_, i) => msg(i, `message ${i}`));
		const r = loreReplyRequest({ mailbox: "a@b.fr", subject: "x", messages: list });
		assert.equal(r.messages.length, LORE_MAX_MESSAGES);
		assert.equal(r.messages[0].text, "message 15");
		assert.equal(r.messages.at(-1)?.text, "message 74");
	});

	await test("troncature : ~12 000 caracteres par message, mention comprise, jamais au-dela", () => {
		const long = "a".repeat(50_000);
		const r = loreReplyRequest({ mailbox: "a@b.fr", subject: "x", messages: [msg(1, long)] });
		assert.ok(r.messages[0].text.length <= LORE_MAX_CHARS_PER_MESSAGE, `longueur ${r.messages[0].text.length}`);
		assert.ok(r.messages[0].text.length > LORE_MAX_CHARS_PER_MESSAGE - 100);
		assert.match(r.messages[0].text, /\[… message tronqué, \d+ caractères omis\]$/);
		assert.equal(clipLoreText("court"), "court");
		const exact = "b".repeat(LORE_MAX_CHARS_PER_MESSAGE);
		assert.equal(clipLoreText(exact), exact);
		const kept = clipLoreText("c".repeat(LORE_MAX_CHARS_PER_MESSAGE + 1));
		const omitted = Number(kept.match(/tronqué, (\d+) caractères/)?.[1]);
		assert.equal(kept.replace(/\n\[…[^\]]*\]$/, "").length + omitted, LORE_MAX_CHARS_PER_MESSAGE + 1);
	});

	// --- Appel HTTP ----------------------------------------------------------------------
	await test("appel : URL, en-tetes du contrat, corps JSON", async () => {
		const seen: { url?: string; init?: RequestInit } = {};
		const body = loreReplyRequest({ mailbox: "a@b.fr", subject: "x", messages: [msg(1, "t")], instruction: "court" });
		const reply = await requestLoreReply(cfg(fakeFetch(200, ok200, seen)), body);
		assert.equal(seen.url, `https://lore.example.test${LORE_REPLY_PATH}`);
		assert.equal(seen.init?.method, "POST");
		const h = seen.init?.headers as Record<string, string>;
		assert.equal(h.Authorization, "Bearer jeton");
		assert.equal(h["X-Lore-Act-As"], "samuel@ss2i-digital.fr");
		assert.equal(h.Accept, "application/json");
		assert.equal(h["Content-Type"], "application/json");
		assert.deepEqual(JSON.parse(String(seen.init?.body)), body);
		assert.equal(reply.bodyText, "Bonjour Madame,\n\nMerci pour votre retour.\nBien cordialement,");
		assert.equal(reply.model, "claude-test");
		assert.deepEqual(reply.sources, [{ title: "Fiche client", url: "https://crm.example/1" }]);
	});

	const req = loreReplyRequest({ mailbox: "a@b.fr", subject: "x", messages: [msg(1, "t")] });
	await test("erreur : { message } de Lore affiche tel quel", async () => {
		await rejects(
			requestLoreReply(cfg(fakeFetch(422, JSON.stringify({ message: "Le fil est vide." }))), req),
			"Le fil est vide.",
		);
		await rejects(
			requestLoreReply(cfg(fakeFetch(403, JSON.stringify({ message: "Utilisateur inconnu de Lore." }))), req),
			"Utilisateur inconnu de Lore.",
		);
	});

	await test("erreur : sans message lisible (page HTML d'un proxy), message selon le statut", async () => {
		await rejects(requestLoreReply(cfg(fakeFetch(401, "")), req), /refusé l'accès \(HTTP 401\).*LORE_APP_TOKEN/);
		await rejects(requestLoreReply(cfg(fakeFetch(404, "<html>404</html>")), req), /HTTP 404/);
		await rejects(requestLoreReply(cfg(fakeFetch(429, "{}")), req), /saturé \(HTTP 429\)/);
		await rejects(requestLoreReply(cfg(fakeFetch(502, "<html>Bad gateway</html>")), req), /erreur \(HTTP 502\)/);
		await rejects(requestLoreReply(cfg(fakeFetch(418, "")), req), "Lore a répondu une erreur HTTP 418.");
	});

	await test("erreur : 200 illisible ou sans texte", async () => {
		await rejects(requestLoreReply(cfg(fakeFetch(200, "<html>login</html>")), req), /illisible/);
		await rejects(requestLoreReply(cfg(fakeFetch(200, JSON.stringify({ body_text: " ", body_html: "" }))), req), /aucun texte/);
	});

	await test("erreur : Lore injoignable, code reseau dans le message", async () => {
		const down = (async () => {
			throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
		}) as typeof fetch;
		await rejects(requestLoreReply(cfg(down), req), /injoignable \(ECONNREFUSED\)/);
	});

	await test("erreur : delai depasse, la requete est abandonnee", async () => {
		let aborted = false;
		const slow = ((_u: any, init: any) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => {
					aborted = true;
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				});
			})) as typeof fetch;
		await rejects(requestLoreReply(cfg(slow, { timeoutMs: 30 }), req), "Lore n'a pas répondu en 1 s : réessayez dans un instant.");
		assert.ok(aborted);
	});

	// --- Brouillon ----------------------------------------------------------------------
	await test("brouillon : HTML refait depuis le texte (echappe), body_html seulement en secours", () => {
		const b = loreDraftBody({ bodyText: "Bonjour,\n\nMerci <b>!</b>\nA bientot", bodyHtml: "<p onclick=x>ignore</p>" });
		assert.equal(b.text, "Bonjour,\n\nMerci <b>!</b>\nA bientot");
		assert.equal(b.html, "<p>Bonjour,</p><p>Merci &lt;b&gt;!&lt;/b&gt;<br>A bientot</p>");
		const h = loreDraftBody({ bodyText: "", bodyHtml: "<p>Bonjour,</p><p>Oui pour mardi.</p><script>x()</script>" });
		assert.match(h.text, /Bonjour,/);
		assert.match(h.text, /Oui pour mardi\./);
		assert.ok(!/script|x\(\)/.test(h.html), h.html);
	});

	await test("destinataires : message recu -> ceux de Repondre a tous", () => {
		const computed = { to: ["c@client.fr"], cc: ["d@client.fr"] };
		const r = loreDraftRecipients(computed, { from: ["c@client.fr"], to: ["samuel@ss2i-digital.fr"], cc: ["d@client.fr"] }, ["samuel@ss2i-digital.fr"]);
		assert.deepEqual(r, computed);
	});

	await test("destinataires : relance d'un message envoye par nous -> ses destinataires, sans nous", () => {
		const own = ["Samuel@ss2i-digital.fr", "jb@ss2i-digital.fr"];
		const r = loreDraftRecipients(
			{ to: ["samuel@ss2i-digital.fr"], cc: ["c@client.fr"] },
			{ from: ["samuel@ss2i-digital.fr"], to: ["c@client.fr", "C@client.fr", "jb@ss2i-digital.fr"], cc: ["d@client.fr", "c@client.fr"] },
			own,
		);
		assert.deepEqual(r, { to: ["c@client.fr"], cc: ["d@client.fr"] });
		const ccOnly = loreDraftRecipients(
			{ to: ["samuel@ss2i-digital.fr"], cc: [] },
			{ from: ["samuel@ss2i-digital.fr"], to: ["samuel@ss2i-digital.fr"], cc: ["d@client.fr"] },
			own,
		);
		assert.deepEqual(ccOnly, { to: ["d@client.fr"], cc: [] });
	});

	await test("objet : comme l'editeur pour une reponse", () => {
		assert.equal(loreReplySubject("Devis"), "Devis");
		assert.equal(loreReplySubject("RE: Devis"), "Devis");
		assert.equal(loreReplySubject("Fwd: Devis"), "Devis");
	});

	await test("configuration : variables manquantes nommees", () => {
		assert.deepEqual(loreConfigMissing({}), ["LORE_URL", "LORE_APP_TOKEN"]);
		assert.deepEqual(loreConfigMissing({ LORE_URL: "https://x", LORE_APP_TOKEN: "  " }), ["LORE_APP_TOKEN"]);
		assert.deepEqual(loreConfigMissing({ LORE_URL: "https://x", LORE_APP_TOKEN: "t" }), []);
	});

	// --- Cablage -------------------------------------------------------------------------
	const web = join(__dirname, "..");
	const src = (p: string) => readFileSync(join(web, p), "utf8");

	await test("bouton « Repondre avec Lore » monte dans les deux interfaces", () => {
		for (const file of ["components/mailbox/default/email-renderer.tsx", "components/k/thread-toolbar.tsx"]) {
			const s = src(file);
			assert.match(s, /import \{ ReplyWithLore \} from "@\/components\/mailbox\/default\/reply-with-lore"/, file);
			const at = s.indexOf("<ReplyWithLore");
			assert.ok(at >= 0, `${file} : <ReplyWithLore absent`);
			const tag = s.slice(at, at + 800);
			assert.match(tag, /identityPublicId=\{/, `${file} : identityPublicId`);
			assert.match(tag, /threadId=\{String\(threadId\)\}/, `${file} : threadId`);
			assert.match(tag, /label="Répondre avec Lore"/, `${file} : infobulle`);
		}
		// Interface classique : chaque en-tete de message repond a son message.
		assert.match(src("components/mailbox/default/email-renderer.tsx"), /<ReplyWithLore[\s\S]*?messageId=\{String\(message\.id\)\}/);
	});

	await test("action serveur : seules les deux actions prevues sont exportees", () => {
		// Tout export d'un fichier "use server" devient un point d'entree public (avis A du 04/11).
		const s = src("lib/actions/thread-lore.ts");
		assert.ok(s.startsWith('"use server";'));
		const exported = [...s.matchAll(/^export\s+(?:async\s+)?(function|const|let|class)\s+(\w+)/gm)].map((m) => `${m[1]} ${m[2]}`);
		assert.deepEqual(exported.sort(), ["function loreReplyConfig", "function replyWithLore"]);
		for (const fn of ["loreReplyConfig", "replyWithLore"]) {
			const body = s.slice(s.indexOf(`export async function ${fn}`));
			assert.match(body.slice(0, 600), /await isSignedIn\(\)/, `${fn} sans controle de session`);
		}
	});

	await test("Ctrl+Entree n'envoie rien depuis une fenetre sans editeur (consigne Lore)", () => {
		const s = src("public/ss2i-shortcuts.js");
		assert.match(s, /\["send", \["Ctrl\+Enter"\][^\n]*!dansUneFenetreSansEditeur\(\) && cliquer\("Send"\)/);
		assert.match(s, /const dansUneFenetreSansEditeur = \(\) => \{[\s\S]{0,200}\[role="dialog"\]:not\(:has\(\.ProseMirror\)\)/);
	});

	// --- Essai reel (facultatif) --------------------------------------------------------
	const { LORE_URL, LORE_APP_TOKEN, LORE_ACT_AS } = process.env;
	if (LORE_URL && LORE_APP_TOKEN && LORE_ACT_AS) {
		await test("essai reel : Lore redige une reponse a un fil court", async () => {
			const body = loreReplyRequest({
				mailbox: LORE_ACT_AS,
				subject: "Essai courrier : rendez-vous",
				messages: [
					msg(1, "Bonjour Samuel,\n\nPourriez-vous passer mardi prochain a 10 h pour faire le point ?\n\nCordialement,\nClaire", {
						to: [LORE_ACT_AS],
					}),
				],
				instruction: "Accepter, en deux phrases.",
			});
			const t0 = Date.now();
			const reply = await requestLoreReply({ url: LORE_URL, token: LORE_APP_TOKEN, actAs: LORE_ACT_AS }, body);
			console.log(`      ${Date.now() - t0} ms, ${reply.model} : ${reply.bodyText.slice(0, 160).replace(/\n/g, " / ")}`);
			assert.ok(reply.bodyText.length > 10);
		});
	} else {
		console.log("--    essai reel ignore (LORE_URL, LORE_APP_TOKEN, LORE_ACT_AS absents)");
	}

	if (failures) {
		console.log(`\n${failures} test(s) en echec`);
		process.exit(1);
	}
	console.log("\nTous les tests passent.");
}

void main();
