// Unsubscribe (packages/common/src/list-unsubscribe.ts): extraction of the List-* headers
// (mailparser `list` form and raw header), subscription key, mailto with subject/body,
// choice of the method. No database. Run (from the repository root):
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

// List-* headers of a newsletter sent through Mailjet, mailparser form.
const mailjet = {
	list: {
		id: { name: "contact.example.net.abc12-xy3z.mj" },
		unsubscribe: {
			url: "https://abc12.mjt.lu/unsub2?m=BAAACbOv&b=2d",
			mail: "unsub-abc@bnc3.mailjet.com",
		},
		"unsubscribe-post": { name: "List-Unsubscribe=One-Click" },
	},
};
const other = {
	list: {
		id: { name: "news.example.org.zzzzz.mj" },
		unsubscribe: { url: "https://abc12.mjt.lu/unsub2?m=ZZZZ&b=9" },
	},
};

test("mailparser: list-id, url, mailto, one-click", () => {
	const i = extractListUnsubscribe(mailjet);
	assert.equal(i.listId, "contact.example.net.abc12-xy3z.mj");
	assert.equal(i.httpUrl, "https://abc12.mjt.lu/unsub2?m=BAAACbOv&b=2d");
	assert.equal(i.mailto, "unsub-abc@bnc3.mailjet.com");
	assert.equal(i.oneClick, true);
});

test("two customers of the same routing provider: distinct keys (Mailjet regression)", () => {
	const a = subscriptionKeyOf(extractListUnsubscribe(mailjet), "contact@example.net");
	const b = subscriptionKeyOf(extractListUnsubscribe(other), "info@example.org");
	assert.notEqual(a, b);
	assert.equal(a, "list-id:contact.example.net.abc12-xy3z.mj");
	assert.equal(b, "list-id:news.example.org.zzzzz.mj");
});

test("without a List-Id: the key carries the sender domain", () => {
	const a = subscriptionKeyOf(extractListUnsubscribe({ list: { unsubscribe: other.list.unsubscribe } }), "x@example.org");
	const b = subscriptionKeyOf(extractListUnsubscribe({ list: { unsubscribe: other.list.unsubscribe } }), "y@example.com");
	assert.equal(a, "from:example.org|https://abc12.mjt.lu/unsub2");
	assert.notEqual(a, b);
});

test("raw header: mailto and https, any order", () => {
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

test("one-click refused without https or without List-Unsubscribe-Post", () => {
	assert.equal(
		extractListUnsubscribe({ "list-unsubscribe": "<http://x.org/u>", "list-unsubscribe-post": "List-Unsubscribe=One-Click" }).oneClick,
		false,
	);
	assert.equal(extractListUnsubscribe({ "list-unsubscribe": "<https://x.org/u>" }).oneClick, false);
});

test("mailto: address, subject, body", () => {
	assert.deepEqual(parseMailto("leave@x.org?subject=unsub%20me&body=please%20remove"), {
		address: "leave@x.org",
		subject: "unsub me",
		body: "please remove",
	});
	assert.deepEqual(parseMailto("mailto:a@b.org"), { address: "a@b.org", subject: null, body: null });
	assert.equal(parseMailto("not-an-address"), null);
	assert.equal(parseMailto(""), null);
});

test("no List-* header: nothing", () => {
	const i = extractListUnsubscribe({ subject: "x" });
	assert.equal(i.listId, null);
	assert.equal(i.httpUrl, null);
	assert.equal(i.mailto, null);
	assert.equal(subscriptionKeyOf(i, "a@b.org"), null);
});

test("method choice: one-click > mailto > web > none", () => {
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: "https://x/u", unsubscribeMailto: "a@b.org", oneClick: true }), "one-click");
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: "https://x/u", unsubscribeMailto: "a@b.org", oneClick: false }), "mailto");
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: "https://x/u", unsubscribeMailto: null, oneClick: false }), "web");
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: "http://x/u", unsubscribeMailto: null, oneClick: true }), "web");
	assert.equal(chooseUnsubscribeMethod({ unsubscribeHttpUrl: null, unsubscribeMailto: null, oneClick: false }), "none");
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
