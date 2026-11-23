// What you type never disappears from the screen: after a tab reloaded by a redeploy during a
// reply, the text used to be missing on opening, then came back. The editor that opens on a draft
// or on a reply resumes the local copy (lib/draft-backup.ts) when it is more recent than the
// server. Run (from the root):
//   node_modules/.bin/tsx apps/web/test/draft-resume.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { backupToDraftRow, pickBackupForEditor } from "../lib/draft-resume";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const NOW = 1_000_000_000;
const backup = (over: Record<string, any> = {}) => ({
	v: 1 as const,
	id: "b1",
	identityPublicId: "ident",
	draftMessageId: "d1" as string | null,
	payload: { mode: "reply", originalMessageId: "m1", subject: "Re: x", html: "<p>text</p>" } as Record<string, string | null>,
	key: "k2",
	savedKey: "k1" as string | null,
	sentAt: null as number | null,
	updatedAt: NOW - 60_000,
	...over,
});
const dead = () => 0;
const forDraft = (over: Record<string, any> = {}) => ({
	draftMessageId: "d1",
	draftUpdatedAt: NOW - 120_000,
	originalMessageId: null,
	mode: null,
	now: NOW,
	aliveAt: dead,
	...over,
});
const forReply = (over: Record<string, any> = {}) => ({
	draftMessageId: null,
	draftUpdatedAt: null,
	originalMessageId: "m1",
	mode: "reply",
	now: NOW,
	aliveAt: dead,
	...over,
});

test("copy more recent than the server: resumed", () => {
	const b = backup();
	assert.equal(pickBackupForEditor([b], forDraft()), b);
});

test("copy already saved (key === savedKey): not resumed", () => {
	assert.equal(pickBackupForEditor([backup({ key: "k1", savedKey: "k1" })], forDraft()), null);
});

test("copy never confirmed by the server (no savedKey): resumed", () => {
	const b = backup({ savedKey: null });
	assert.equal(pickBackupForEditor([b], forDraft()), b);
});

test("sent copy: never resumed", () => {
	assert.equal(pickBackupForEditor([backup({ sentAt: NOW - 5_000 })], forDraft()), null);
});

test("editor alive elsewhere (beat under 10 s): not resumed", () => {
	assert.equal(pickBackupForEditor([backup()], forDraft({ aliveAt: () => NOW - 3_000 })), null);
});

test("old beat (dead or reloaded tab): resumed", () => {
	const b = backup();
	assert.equal(pickBackupForEditor([b], forDraft({ aliveAt: () => NOW - 30_000 })), b);
});

test("server draft saved well after the copy: the server is more recent, not resumed", () => {
	assert.equal(pickBackupForEditor([backup()], forDraft({ draftUpdatedAt: NOW + 10 * 60_000 })), null);
});

test("client/server clock skew of a few seconds: the copy is still resumed", () => {
	const b = backup();
	assert.equal(pickBackupForEditor([b], forDraft({ draftUpdatedAt: NOW - 60_000 + 5_000 })), b);
});

test("copy of another draft: not resumed", () => {
	assert.equal(pickBackupForEditor([backup({ draftMessageId: "d2" })], forDraft()), null);
});

test("reply never saved, found by originalMessageId and mode", () => {
	const b = backup({ draftMessageId: null, savedKey: null });
	assert.equal(pickBackupForEditor([b], forReply()), b);
});

test("reply all and reply are the same mode; forward is another one", () => {
	const b = backup({ draftMessageId: null, savedKey: null });
	assert.equal(pickBackupForEditor([b], forReply({ mode: "replyAll" })), b);
	assert.equal(pickBackupForEditor([b], forReply({ mode: "forward" })), null);
});

test("reply to another message: not resumed", () => {
	const b = backup({ draftMessageId: null, savedKey: null });
	assert.equal(pickBackupForEditor([b], forReply({ originalMessageId: "m2" })), null);
});

test("forward never saved, found by originalMessageId and mode", () => {
	const b = backup({ draftMessageId: null, savedKey: null, payload: { mode: "forward", originalMessageId: "m1" } });
	assert.equal(pickBackupForEditor([b], forReply({ mode: "forward" })), b);
});

test("reply without a draft: a copy linked to a server draft is not resumed (the draft is what opens)", () => {
	assert.equal(pickBackupForEditor([backup({ draftMessageId: "d1" })], forReply()), null);
});

test("new message without original nor draft: nothing to resume", () => {
	const b = backup({ draftMessageId: null, savedKey: null, payload: { mode: "compose", originalMessageId: null } });
	assert.equal(pickBackupForEditor([b], forReply({ originalMessageId: null, mode: "compose" })), null);
});

test("several candidate copies: the most recent", () => {
	const old = backup({ id: "old", updatedAt: NOW - 90_000 });
	const recent = backup({ id: "recent", updatedAt: NOW - 20_000 });
	assert.equal(pickBackupForEditor([old, recent], forDraft()), recent);
	assert.equal(pickBackupForEditor([recent, old], forDraft()), recent);
});

test("existing v1 copy (no added field): readable, nothing more is required", () => {
	const b = backup();
	assert.equal(b.v, 1);
	assert.ok(pickBackupForEditor([b], forDraft()));
});

test("backupToDraftRow: editor fields rebuilt from the copy, the server draft untouched", () => {
	const base = { id: "d1", subject: "old", html: "<p>old</p>", to: { value: [] }, metaData: { draft: { revision: 3, mode: "reply" }, imap: { uid: 4 } } };
	const b = backup({
		payload: {
			mode: "reply",
			originalMessageId: "m1",
			to: "John Doe <john@x.com>, mary@x.com",
			cc: "paul@x.com",
			bcc: "",
			subject: "Re: new",
			html: "<p>new</p>",
			attachments: JSON.stringify([{ path: "p", filenameOriginal: "a.pdf" }]),
			includeSignature: "false",
			quoteScope: "thread",
			quoteMode: "custom",
			quoteHtml: "<p>quote</p>",
		},
	});
	const row: any = backupToDraftRow(b, base as any);
	assert.equal(row.id, "d1");
	assert.equal(row.subject, "Re: new");
	assert.equal(row.html, "<p>new</p>");
	assert.deepEqual(row.to.value, [{ name: "John Doe", address: "john@x.com" }, { name: "", address: "mary@x.com" }]);
	assert.deepEqual(row.cc.value, [{ name: "", address: "paul@x.com" }]);
	assert.deepEqual(row.bcc.value, []);
	const meta = row.metaData.draft;
	assert.equal(meta.mode, "reply");
	assert.equal(meta.revision, 3);
	assert.equal(meta.includeSignature, false);
	assert.equal(meta.quoteScope, "thread");
	assert.equal(meta.quoteMode, "custom");
	assert.equal(meta.quoteHtml, "<p>quote</p>");
	assert.deepEqual(meta.attachments, [{ path: "p", filenameOriginal: "a.pdf" }]);
	assert.deepEqual(row.metaData.imap, { uid: 4 });
	assert.equal((base.metaData.draft as any).quoteScope, undefined);
});

test("backupToDraftRow without a server draft: synthetic row (empty id, forward, default signature)", () => {
	const row: any = backupToDraftRow(
		backup({ draftMessageId: null, payload: { mode: "forward", originalMessageId: "m1", subject: "Fwd: x", html: "<p>t</p>", attachments: "[]" } }),
		null,
	);
	assert.equal(row.id, "");
	assert.equal(row.metaData.draft.mode, "forward");
	assert.deepEqual(row.metaData.draft.attachments, []);
	assert.equal(row.metaData.draft.includeSignature, true);
});

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("editor: picks the copy before the first render, takes over its id and beats right away", () => {
	const src = read("components/mailbox/default/editor/email-editor.tsx");
	assert.match(src, /pickBackupForEditor\(/);
	assert.match(src, /useRef<string>\(resume\?\.id \?\? newBackupId\(\)\)/);
	assert.match(src, /touchAlive\(resume\.id\)/);
	assert.match(src, /Text restored from this browser/);
	assert.match(src, /draftRow: shownDraft/);
	assert.match(src, /defaultValue=\{shownDraft\?\.html \?\? ""\}/);
});

test("editor: a closing or reloading tab releases its beat (the copy is resumed right away)", () => {
	const src = read("components/mailbox/default/editor/email-editor.tsx");
	assert.match(src, /clearAlive\(backupId\.current\)/);
	assert.match(src, /if \(!e\.persisted\)/, "a bfcache freeze is not a close");
	assert.match(src, /if \(!leaving\.current\) touchAlive/);
});

test("recovery: time read again for each copy", () => {
	const src = read("components/mailbox/default/draft-backup-recovery.tsx");
	assert.match(src, /for \(const b of listBackups\(\)\) \{[\s\S]*?const now = Date\.now\(\);/);
});

if (failures) {
	console.log(`\n${failures} test(s) failed`);
	process.exit(1);
}
console.log("\ndraft-resume: all tests pass");
