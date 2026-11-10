// Subject without reply and forward prefixes, as a per-user option (Settings > General >
// Reading), off by default. Off: "Re:" and "Fwd:" are added when replying and forwarding, the
// subject is displayed as received (original behaviour). On: no prefix is added, those stacked
// by other clients ("RE: TR: RE: Fwd:", "AW:", "Re[2]:") are removed when sending and in the
// lists, the search, the unread panel and the threads of both interfaces.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/subject-prefixes.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { composeMessage } from "../../../packages/common/src/compose";
import { stripSubjectPrefixes, subjectForDisplay } from "../../../packages/common/src/subject";

let failed = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failed++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};
const read = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

test("stripSubjectPrefixes: stacked prefixes, any case, any language", () => {
	assert.equal(stripSubjectPrefixes("Re: Quote"), "Quote");
	assert.equal(stripSubjectPrefixes("RE: Quote"), "Quote");
	assert.equal(stripSubjectPrefixes("Fwd: Quote"), "Quote");
	assert.equal(stripSubjectPrefixes("RE: TR: RE: Fwd: Quote"), "Quote");
	assert.equal(stripSubjectPrefixes("AW: WG: Angebot"), "Angebot");
	assert.equal(stripSubjectPrefixes("Antw: Re : Offerte"), "Offerte");
	assert.equal(stripSubjectPrefixes("Re[2]: Quote"), "Quote");
	assert.equal(stripSubjectPrefixes("RE(3): Quote"), "Quote");
	assert.equal(stripSubjectPrefixes("Re： Quote"), "Quote");
	assert.equal(stripSubjectPrefixes("  Re:   Quote  "), "Quote");
});

test("stripSubjectPrefixes: a word that merely starts like a prefix stays", () => {
	assert.equal(stripSubjectPrefixes("Reminder: invoice"), "Reminder: invoice");
	assert.equal(stripSubjectPrefixes("Resume: plan"), "Resume: plan");
	assert.equal(stripSubjectPrefixes("Quote Re: x"), "Quote Re: x");
	assert.equal(stripSubjectPrefixes("Trade: 12"), "Trade: 12");
});

test("stripSubjectPrefixes: empty and missing subjects", () => {
	assert.equal(stripSubjectPrefixes(null), "");
	assert.equal(stripSubjectPrefixes(undefined), "");
	assert.equal(stripSubjectPrefixes("Re:"), "");
	assert.equal(stripSubjectPrefixes("Re: Fwd: "), "");
});

test("subjectForDisplay: option off keeps the subject as received, on strips it", () => {
	assert.equal(subjectForDisplay("RE: TR: Quote", false), "RE: TR: Quote");
	assert.equal(subjectForDisplay("RE: TR: Quote", true), "Quote");
	assert.equal(subjectForDisplay(null, false), "");
	assert.equal(subjectForDisplay(undefined, true), "");
});

const orig = { subject: "RE: TR: Quote", html: "<p>Hi</p>", text: "Hi", fromName: "Ann", fromAddress: "a@x.test", dateLabel: "d" };

test("send, option off (default): Re: and Fwd: added as before", () => {
	assert.equal(composeMessage({ mode: "reply", orig: { ...orig, subject: "Quote" } }).subject, "Re: Quote");
	assert.equal(composeMessage({ mode: "forward", orig: { ...orig, subject: "Quote" } }).subject, "Fwd: Quote");
	assert.equal(composeMessage({ mode: "reply", orig: { ...orig, subject: "Re: Quote" } }).subject, "Re: Quote");
	assert.equal(
		composeMessage({ mode: "reply", stripSubjectPrefixes: false, orig: { ...orig, subject: "Quote" } }).subject,
		"Re: Quote",
	);
});

test("send, option on: no prefix added, stacked ones removed, edited subject wins", () => {
	const on = { stripSubjectPrefixes: true } as const;
	assert.equal(composeMessage({ ...on, mode: "reply", orig }).subject, "Quote");
	assert.equal(composeMessage({ ...on, mode: "forward", orig }).subject, "Quote");
	assert.equal(composeMessage({ ...on, mode: "reply", subject: "Re: Other", orig }).subject, "Other");
	assert.equal(composeMessage({ ...on, mode: "reply", orig: { ...orig, subject: "" } }).subject, "(no subject)");
	assert.equal(composeMessage({ ...on, mode: "new", subject: "Hello" }).subject, "Hello");
});

test("editor header: the option decides, off keeps the Re:/Fwd: prefix", () => {
	const src = read("components/mailbox/default/editor/editor-header.tsx");
	assert.ok(src.includes("useStripSubjectPrefixes"), "editor-header.tsx must read the option");
	assert.ok(src.includes("stripSubjectPrefixes("), "editor-header.tsx must strip when the option is on");
	assert.ok(/`Re: \$\{/.test(src) && /`Fwd: \$\{/.test(src), "editor-header.tsx keeps the prefix when the option is off");
});

test("displays: lists and threads go through subjectForDisplay with the option", () => {
	for (const p of [
		"components/mailbox/default/webmail-list-item.tsx",
		"components/mailbox/default/webmail-list-item-mobile.tsx",
		"components/mailbox/default/email-renderer.tsx",
		"components/mailbox/default/unread-panel.tsx",
		"components/mailbox/default/mailbox-search.tsx",
		"components/k/thread-row.tsx",
		"components/k/thread-page.tsx",
	]) {
		const src = read(p);
		assert.ok(src.includes("subjectForDisplay("), `${p} must display subjectForDisplay(...)`);
		assert.ok(/useStripSubjectPrefixes|stripSubjectPrefixesEnabled/.test(src), `${p} must read the option`);
	}
});

test("option: off by default, per user in workspaces.meta, read by the worker", () => {
	const action = read("lib/actions/subject-prefixes.ts");
	assert.ok(action.includes("prefStripSubjectPrefixes"));
	assert.ok(action.includes("::boolean, false)"), "off when the key is absent");
	const worker = readFileSync(join(__dirname, "../../worker/server/plugins/send-mail.ts"), "utf8");
	assert.ok(worker.includes("prefStripSubjectPrefixes"), "send-mail.ts must read the option");
	assert.ok(read("components/mailbox/settings/settings-unread-panel.tsx").includes("setStripSubjectPrefixesEnabled"));
});

if (failed) {
	console.log(`\n${failed} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
