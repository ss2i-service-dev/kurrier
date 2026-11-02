// Desinscription (packages/common/src/list-unsubscribe.ts) : extraction des en-tetes List-*
// (forme `list` de mailparser et en-tete brut), cle d'abonnement, mailto avec subject/body,
// choix de la methode. Aucune base. Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/list-unsubscribe.ts
import assert from "node:assert/strict";
import {
	chooseUnsubscribeMethod,
	extractListUnsubscribe,
	parseMailto,
	subscriptionKeyOf,
} from "../../../packages/common/src/list-unsubscribe";

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

// En-tetes reels du message « INFOMAIL Deja novembre » (Mailjet), forme mailparser.
const mailjet = {
	list: {
		id: { name: "contact.mondejaubureau.fr.13trh-uw1jr.mj" },
		unsubscribe: {
			url: "https://13trh.mjt.lu/unsub2?m=BAAACbOv&b=2d",
			mail: "unsub-abc@bnc3.mailjet.com",
		},
		"unsubscribe-post": { name: "List-Unsubscribe=One-Click" },
	},
};
const other = {
	list: {
		id: { name: "news.autre.com.zzzzz.mj" },
		unsubscribe: { url: "https://13trh.mjt.lu/unsub2?m=ZZZZ&b=9" },
	},
};

test("mailparser : list-id, url, mailto, one-click", () => {
	const i = extractListUnsubscribe(mailjet);
	assert.equal(i.listId, "contact.mondejaubureau.fr.13trh-uw1jr.mj");
	assert.equal(i.httpUrl, "https://13trh.mjt.lu/unsub2?m=BAAACbOv&b=2d");
	assert.equal(i.mailto, "unsub-abc@bnc3.mailjet.com");
	assert.equal(i.oneClick, true);
});

test("deux clients du meme routeur : cles distinctes (regression Mailjet)", () => {
	const a = subscriptionKeyOf(extractListUnsubscribe(mailjet), "contact@mondejaubureau.fr");
	const b = subscriptionKeyOf(extractListUnsubscribe(other), "info@autre.com");
	assert.notEqual(a, b);
	assert.equal(a, "list-id:contact.mondejaubureau.fr.13trh-uw1jr.mj");
	assert.equal(b, "list-id:news.autre.com.zzzzz.mj");
});

test("sans List-Id : la cle porte le domaine expediteur", () => {
	const a = subscriptionKeyOf(extractListUnsubscribe({ list: { unsubscribe: other.list.unsubscribe } }), "x@autre.com");
	const b = subscriptionKeyOf(extractListUnsubscribe({ list: { unsubscribe: other.list.unsubscribe } }), "y@encore.fr");
	assert.equal(a, "from:autre.com|https://13trh.mjt.lu/unsub2");
	assert.notEqual(a, b);
});

test("en-tete brut : mailto et https, ordre quelconque", () => {
	const i = extractListUnsubscribe({
		"list-unsubscribe": "<mailto:leave@x.org?subject=unsub%20me&body=please>, <https://x.org/u/1>",
		"list-unsubscribe-post": "List-Unsubscribe=One-Click",
		"list-id": "Newsletter <news.x.org>",
	});
	assert.equal(i.httpUrl, "https://x.org/u/1");
	assert.equal(i.mailto, "leave@x.org?subject=unsub%20me&body=please");
	assert.equal(i.oneClick, true);
	assert.equal(i.listId, "news.x.org");
});

test("one-click refuse sans https ou sans List-Unsubscribe-Post", () => {
	assert.equal(
		extractListUnsubscribe({ "list-unsubscribe": "<http://x.org/u>", "list-unsubscribe-post": "List-Unsubscribe=One-Click" }).oneClick,
		false,
	);
	assert.equal(extractListUnsubscribe({ "list-unsubscribe": "<https://x.org/u>" }).oneClick, false);
});

test("mailto : adresse, subject, body", () => {
	assert.deepEqual(parseMailto("leave@x.org?subject=unsub%20me&body=please%20remove"), {
		address: "leave@x.org",
		subject: "unsub me",
		body: "please remove",
	});
	assert.deepEqual(parseMailto("mailto:a@b.fr"), { address: "a@b.fr", subject: null, body: null });
	assert.equal(parseMailto("pas-une-adresse"), null);
	assert.equal(parseMailto(""), null);
});

test("aucun en-tete List-* : rien", () => {
	const i = extractListUnsubscribe({ subject: "x" });
	assert.equal(i.listId, null);
	assert.equal(i.httpUrl, null);
	assert.equal(i.mailto, null);
	assert.equal(subscriptionKeyOf(i, "a@b.fr"), null);
});

test("choix de la methode : one-click > mailto > web > none", () => {
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: "https://x/u", unsubscribeMailto: "a@b.fr", oneClick: true }), "one-click");
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: "https://x/u", unsubscribeMailto: "a@b.fr", oneClick: false }), "mailto");
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: "https://x/u", unsubscribeMailto: null, oneClick: false }), "web");
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: "http://x/u", unsubscribeMailto: null, oneClick: true }), "web");
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: null, unsubscribeMailto: null, oneClick: false }), "none");
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
