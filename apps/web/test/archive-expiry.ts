// "Archive for..." (archive with an expiry), web side: the server action passes the expiry to the
// mail:move job (never set before the move), setThreadExpiry and the "Expiring soon" view exist,
// the "Disappears on DD Mon YYYY" mention is displayed in both interfaces, the menu has no 12 h
// selector (date only, no time) and does not capture the `a` shortcut (keyboard-shortcuts.js
// targets data-k-action="archive" and data-k-shortcut="selection-archive", never the new
// button). No database, no network. From the root:
//   node_modules/.bin/tsx apps/web/test/archive-expiry.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { archivedMessage, expiryMenuOptions, mailboxKindOf, pickerDate } from "../lib/archive-for";

let failed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL ${name}\n${(e as Error).stack}`);
	}
}

const ROOT = join(__dirname, "..", "..", "..");
const WEB = join(ROOT, "apps", "web");
const src = (p: string) => readFileSync(join(WEB, p), "utf8");
// Source without comments: a comment that quotes "AM/PM" must not count.
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date(2026, 10, 19, 10, 30, 0);

test("archivedMessage: DD Mon YYYY date, plural, starred threads", () => {
	const d = new Date(2026, 11, 19);
	assert.equal(archivedMessage({ count: 1, expiresAt: d, starred: false }), "Archived, will disappear on 19 Dec 2026");
	assert.equal(archivedMessage({ count: 3, expiresAt: d, starred: false }), "3 threads archived, will disappear on 19 Dec 2026");
	assert.equal(archivedMessage({ count: 1, expiresAt: d, starred: true }), "Archived. Starred threads do not expire.");
	assert.equal(archivedMessage({ count: 2, expiresAt: d, starred: true }), "2 threads archived. Starred threads do not expire.");
	assert.equal(archivedMessage({ count: 1, expiresAt: null, starred: false }), "Archived");
	assert.equal(archivedMessage({ count: 4, expiresAt: null, starred: false }), "4 threads archived");
});

test("expiryMenuOptions: the 5 durations, DD Mon YYYY date and ISO of the local start of day", () => {
	const opts = expiryMenuOptions(NOW);
	assert.deepEqual(opts.map((o) => [o.id, o.label, o.date]), [
		["1m", "1 month", "19 Dec 2026"],
		["3m", "3 months", "19 Feb 2027"],
		["6m", "6 months", "19 May 2027"],
		["1y", "1 year", "19 Nov 2027"],
		["2y", "2 years", "19 Nov 2028"],
	]);
	assert.equal(opts[0].iso, new Date(2026, 11, 19).toISOString());
});

test("pickerDate: \"YYYY-MM-DD\" (Mantine 8) or Date -> local start of day, otherwise null", () => {
	assert.equal(pickerDate("2026-12-25")?.getTime(), new Date(2026, 11, 25).getTime());
	assert.equal(pickerDate(new Date(2026, 11, 25, 15, 45))?.getTime(), new Date(2026, 11, 25).getTime());
	assert.equal(pickerDate(null), null);
	assert.equal(pickerDate(""), null);
	assert.equal(pickerDate("not a date"), null);
});

test("mailboxKindOf: kind of the active folder among the identities' folders, empty if unknown", () => {
	const boxes = [
		{ mailboxes: [{ id: "a1", kind: "inbox" }, { id: "a2", kind: "archive" }] },
		{ mailboxes: [{ id: "b1", kind: "trash" }] },
	] as any;
	assert.equal(mailboxKindOf(boxes, "a2"), "archive");
	assert.equal(mailboxKindOf(boxes, "b1"), "trash");
	assert.equal(mailboxKindOf(boxes, "zz"), "");
	assert.equal(mailboxKindOf(null, "a1"), "");
});

test("archiveThread: 5th parameter expiresAt, validated by parseExpiry, added to the mail:move job data", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export const archiveThread");
	assert.ok(at > 0, "archiveThread not found");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body, /expiresAt\?:\s*string\s*\|\s*null/, "optional 5th parameter");
	assert.match(body, /parseExpiry\(\s*expiresAt\s*,\s*new Date\(\)\s*\)/, "validation by parseExpiry");
	const job = body.slice(body.indexOf('"mail:move"'), body.indexOf("removeOnComplete", body.indexOf('"mail:move"')));
	assert.match(job, /op:\s*"archive"/);
	assert.match(job, /expiresAt/, "the expiry goes in the job data");
});

test("setThreadExpiry: a list of threads in one call, clear error if no row was touched (.returning)", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export async function setThreadExpiry");
	assert.ok(at > 0, "setThreadExpiry not found");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body, /threadIds:\s*string\[\]/, "threadIds is a list");
	assert.match(body, /inArray\(mailboxThreads\.threadId/, "a single update for the list");
	assert.match(body, /\.returning\(/, "the update returns the touched rows");
	assert.match(body, /length\s*===\s*0/, "no row touched -> failure");
	assert.match(body, /ok:\s*false,\s*reason:/, "clear message");
});

test("setThreadExpiry: archive only, null cancels, refuses a starred thread or an INBOX row", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export async function setThreadExpiry");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body, /rlsClient\(\)/);
	assert.match(body, /assertThreadsInMailbox\(/);
	assert.match(body, /kind\s*!==\s*"archive"/, "refused outside the archive folder");
	assert.match(body, /parseExpiry\(/);
	assert.match(body, /starred/, "starred thread refused");
	assert.match(body, /"inbox"/, "refused with an INBOX row of the same identity");
	assert.match(body, /ok:\s*false/);
});

test("fetchIdentityExpiringThreads: identity as parameter, archive folder, ascending order, 200 rows, server-side filters", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export const fetchIdentityExpiringThreads");
	assert.ok(at > 0, "fetchIdentityExpiringThreads not found");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body.slice(0, 200), /\(\s*identityPublicId:\s*string/, "identity as parameter");
	assert.match(body, /isNotNull\(mailboxThreads\.expiresAt\)/);
	assert.match(body, /eq\(mailboxThreads\.identityPublicId,\s*identityPublicId\)/, "identity filter on the server");
	assert.match(body, /innerJoin\(mailboxes/, "join on the folder");
	assert.match(body, /eq\(mailboxes\.kind,\s*"archive"\)/, "archive folder only");
	assert.match(body, /asc\(mailboxThreads\.expiresAt\)/);
	assert.match(body, /\.limit\(200\)/);
});

test("fetchExpiringCounts: sidebar counter per identity, archive folder, computed on the server", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export const fetchExpiringCounts");
	assert.ok(at > 0, "fetchExpiringCounts not found");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body, /isNotNull\(mailboxThreads\.expiresAt\)/);
	assert.match(body, /eq\(mailboxes\.kind,\s*"archive"\)/);
	assert.match(body, /groupBy\(mailboxThreads\.identityId\)/);
});

test("lists: list queries return the whole row (expiresAt included)", () => {
	// No list query enumerates its columns: select({ thread: mailboxThreads }) returns expiresAt.
	for (const f of ["lib/actions/mailbox.ts", "lib/actions/k-threads.ts"]) {
		assert.match(code(f), /select\(\{\s*thread:\s*mailboxThreads\s*\}\)|\.select\(\)\s*\.from\(mailboxThreads\)/, f);
	}
});

test("mail-store: mailActions.archive passes expiresAt to archiveThread", () => {
	const s = code("components/k/mail-store.ts");
	const at = s.indexOf("archive(threadIds");
	const body = s.slice(at, s.indexOf("trash(threadIds", at));
	assert.match(body, /expiresAt/);
	assert.match(body, /archiveThread\(list,\s*mailboxId,\s*smtp,\s*false,\s*expiresAt\)/);
});

test("thread-row: \"Disappears on\" mention (formatExpiry, text-k-warn) when expiresAt is set", () => {
	const s = code("components/k/thread-row.tsx");
	assert.match(s, /Disappears on/);
	assert.match(s, /formatExpiry\(/);
	assert.match(s, /item\.expiresAt/);
	assert.match(s, /text-k-warn/);
});

test("open mail: notice and \"Keep\" button (setThreadExpiry to null)", () => {
	const s = code("components/k/expiry-notice.tsx");
	assert.match(s, /Disappears on/);
	assert.match(s, /Keep/);
	assert.match(s, /setThreadExpiry\(\{[^}]*expiresAt:\s*null/);
	assert.match(code("components/k/thread-page.tsx"), /KExpiryNotice/);
});

test("archive-for.tsx: no 12 h selector, no AM/PM, date only", () => {
	const s = code("components/k/archive-for.tsx");
	assert.ok(!/format:\s*"12h"/.test(s), 'format: "12h"');
	assert.ok(!/hh:mm A/.test(s), "hh:mm A");
	assert.ok(!/\b(AM|PM)\b/.test(s), "isolated word AM or PM");
	assert.ok(!/DateTimePicker|TimeInput|TimePicker/.test(s), "no time selector");
	assert.match(s, /<DatePicker\b/, "inline calendar");
	assert.match(s, /formatExpiry\(/, "chosen date displayed as DD Mon YYYY");
	assert.match(s, /minDate=/);
	assert.match(s, /expiryMenuOptions/);
});

test("archive-for.tsx: a selection in the Archive = a single server call", () => {
	const s = code("components/k/archive-for.tsx");
	assert.match(s, /setThreadExpiry\(\{\s*threadIds:\s*ids\b/, "setThreadExpiry({ threadIds: ids, ... })");
	assert.ok(!/ids\.map\([^)]*setThreadExpiry/.test(s), "no more one call per thread");
	assert.ok(!/Promise\.all/.test(s), "no Promise.all");
});

test("archive-for.tsx: does not capture the `a` shortcut; bare button: title tooltip, no text", () => {
	const s = code("components/k/archive-for.tsx");
	assert.ok(!/data-k-action|action=["{]\s*"?archive/.test(s), 'data-k-action="archive"');
	assert.ok(!/data-k-shortcut/.test(s), "data-k-shortcut");
	assert.ok(!/<KIconButton\b[^>]*\btitle=/.test(s), "the KIconButton already has its tooltip (label)");
	// keyboard-shortcuts.js falls back on textContent ("Archive..."): the bare button only holds the icon.
	const bulk = /<button\b[^>]*aria-label=\{label\}[^>]*>([\s\S]*?)<\/button>/.exec(s);
	assert.ok(bulk, "bare button of the selection bar not found");
	assert.equal(bulk![1].trim(), "{icon}", "no text in the button: empty textContent");
	const shortcuts = src("public/keyboard-shortcuts.js");
	assert.ok(!/getAttribute\(["']title["']\)|\[title[\]=*^$~|]/.test(shortcuts), "keyboard-shortcuts.js never targets by title");
});

test("archive-for: next to each \"Archive\" (selection, row, open mail's bar), modern and classic", () => {
	for (const f of [
		"components/k/list-header.tsx",
		"components/k/thread-row.tsx",
		"components/k/thread-toolbar.tsx",
		"components/mailbox/default/mail-list-header.tsx",
		"components/mailbox/default/webmail-list-item.tsx",
		"components/mailbox/default/email-renderer.tsx",
	]) {
		assert.match(code(f), /<KArchiveFor\b/, f);
	}
});

test("expiring view: expiring page and sidebar link under \"Snoozed\"", () => {
	const page = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/expiring/page.tsx";
	assert.ok(existsSync(join(WEB, page)), page);
	assert.match(code(page), /fetchIdentityExpiringThreads\(\s*identityPublicId\s*\)/);
	const nav = code("components/k/sidebar-nav.tsx");
	assert.match(nav, /\/expiring`/);
	assert.match(nav, /Expiring soon/);
	assert.ok(nav.indexOf("Snoozed") < nav.indexOf("Expiring soon"), "\"Expiring soon\" under \"Snoozed\"");
	assert.match(code("components/k/sidebar-nav-wrapper.tsx"), /fetchExpiringCounts\(\)/);
});

// CLASSIC interface (per-user option, components/k/ui-context.tsx): same components, same server actions.
const PAGES = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]";
const THREAD_PAGES = [
	`${PAGES}/[mailboxSlug]/threads/[threadId]/page.tsx`,
	`${PAGES}/[mailboxSlug]/@thread/(.)threads/[threadId]/page.tsx`,
];

test("classic, list row: \"Archive for...\" on hover, between Archive and Delete, Archive untouched", () => {
	const s = code("components/mailbox/default/webmail-list-item.tsx");
	assert.match(s, /import KArchiveFor from "@\/components\/k\/archive-for"/);
	const at = s.indexOf("<KArchiveFor");
	assert.ok(at > 0, "<KArchiveFor rendered by the classic row");
	assert.ok(s.indexOf('title="Archive"') < at && at < s.indexOf('title="Delete"'), "between Archive and Delete");
	const tag = s.slice(at, s.indexOf("/>", at));
	assert.match(tag, /mailboxId=\{activeMailbox\.id\}/);
	assert.match(tag, /mailboxKind=\{activeMailbox\.kind\}/);
	assert.match(tag, /smtp=\{!!mailboxSync\}/);
	assert.match(tag, /threadIds=\{\(\) => \[String\(mailboxThreadItem\.threadId\)\]\}/);
	assert.match(tag, /starred=\{\(\) => !!mailboxThreadItem\.starred\}/);
	assert.match(tag, /bulkClassName=/, "bare button, icon only, like its neighbours (no k- style)");
	assert.match(s.slice(Math.max(0, at - 120), at), /!sendPending/, "never on a pending send");
	assert.match(s, /archiveThread\(id, activeMailbox\.id, !!mailboxSync, true\)/, "Archive untouched");
});

test("classic, row: orange \"Disappears on DD Mon YYYY\" mention when expiresAt is set, desktop and mobile", () => {
	for (const f of ["webmail-list-item.tsx", "webmail-list-item-mobile.tsx"]) {
		const s = code(`components/mailbox/default/${f}`);
		assert.match(s, /<ExpiryMention\b[^>]*expiresAt=\{mailboxThreadItem\.expiresAt\}/, f);
		assert.match(s, /import ExpiryMention from "@\/components\/mailbox\/default\/expiry-mention"/, f);
	}
	const m = code("components/mailbox/default/expiry-mention.tsx");
	assert.match(m, /formatExpiry\(/);
	assert.match(m, /Disappears on/);
	assert.match(m, /text-orange-/, "standard Tailwind color: the k- tokens do not exist in classic");
	assert.ok(!/\bk-[a-z]/.test(m), "no k- token");
	assert.match(m, /return null/, "nothing without an expiry");
});

test("classic, selection bar: \"Archive for...\" after Archive (data-k-shortcut untouched), selection cleared first", () => {
	const s = code("components/mailbox/default/mail-list-header.tsx");
	assert.match(s, /import KArchiveFor from "@\/components\/k\/archive-for"/);
	const at = s.indexOf("<KArchiveFor");
	assert.ok(at > 0, "<KArchiveFor rendered by the classic header");
	assert.ok(s.indexOf('data-k-shortcut="selection-archive"') < at, "after the Archive button");
	const tag = s.slice(at, s.indexOf("/>", at));
	assert.match(tag, /mailboxId=\{String\(mailboxIdRef\.current\)\}/);
	assert.match(tag, /mailboxKind=\{String\(mailboxKind\.current\)\}/);
	assert.match(tag, /threadIds=\{\(\) => Array\.from\(state\?\.selectedThreadIds \?\? \[\]\)\.map\(String\)\}/);
	assert.match(tag, /starred=\{/);
	assert.match(tag, /before=\{clearSelection\}/);
	assert.match(tag, /bulkClassName=/);
	assert.match(s, /onClick=\{archiveThreads\}/, "Archive untouched");
});

test("classic, open mail: \"Archive for...\" next to Archive (a), icon only, Archive and its labels untouched", () => {
	const s = code("components/mailbox/default/email-renderer.tsx");
	assert.match(s, /import KArchiveFor from "@\/components\/k\/archive-for"/);
	const at = s.indexOf("<KArchiveFor");
	assert.ok(at > 0, "<KArchiveFor rendered by the classic mail bar");
	assert.ok(s.indexOf('<Tooltip label="Archive (a)"') < at && at < s.indexOf('label="Mark as unread and back to the list"'), "after Archive (a), before Mark as unread");
	const tag = s.slice(at, s.indexOf("/>", at));
	assert.match(tag, /mailboxId=\{activeMailboxId\}/);
	assert.match(tag, /mailboxKind=\{mailboxKindOf\(identityMailboxes, activeMailboxId\)\}/);
	assert.match(tag, /smtp=\{markSmtp\}/);
	assert.match(tag, /threadIds=\{\(\) => \[String\(threadId\)\]\}/);
	assert.match(tag, /starred=\{\(\) => !!starred\}/);
	assert.match(tag, /before=\{leaveThread\}/, "back to the list like Archive");
	assert.match(tag, /renderTrigger=/, "Mantine ActionIcon like its neighbours");
	assert.match(s, /aria-label="Archive" data-k-shortcut="open-archive" onClick=\{archiveMessage\}/, "Archive untouched, marked for a (test/open-mail-archive-shortcut.ts)");
	assert.match(s, /\n\s*Archive\n\s*<\/Button>/, "bottom \"Archive\" text button untouched (textContent fallback of a)");
});

test("classic, open mail: \"Disappears on\" notice with \"Keep\" (KExpiryNotice) in both thread pages, starred passed down", () => {
	for (const f of THREAD_PAGES) {
		const s = code(f);
		assert.match(s, /fetchThreadExpiry\(threadId, activeMailbox\.id\)/, f);
		assert.match(s, /<KExpiryNotice\b[^>]*threadId=\{threadId\}[^>]*mailboxId=\{activeMailbox\.id\}[^>]*expiresAt=\{expiry\.expiresAt\}/, f);
		assert.match(s, /expiry\.expiresAt && /, "only with an expiry");
		assert.match(s, /starred=\{expiry\.starred\}/, `${f}: starred to ThreadItem`);
	}
	assert.match(code("components/mailbox/default/thread-item.tsx"), /starred\??:\s*boolean/);
	assert.match(code("components/mailbox/default/thread-item.tsx"), /starred=\{starred\}/);
});

test("KExpiryNotice and KArchiveFor: classic look without k- tokens (--k-* only exist in the modern interface)", () => {
	const n = code("components/k/expiry-notice.tsx");
	assert.match(n, /useModernUi\(\)/);
	assert.match(n, /bg-orange-50/);
	assert.match(n, /bg-k-warn-soft/, "modern interface unchanged");
	assert.match(n, /className\??:\s*string/, "container margins chosen by the caller");
	const a = code("components/k/archive-for.tsx");
	assert.match(a, /useModernUi\(\)/);
	assert.match(a, /text-muted-foreground/, "menu date in classic");
	assert.match(a, /renderTrigger\??:/);
	// No visible button label starting with "Archive": the textContent fallback of `a` stays on Archive.
	assert.ok(!/<ActionIcon[^>]*>\s*Archive/.test(a));
});

test("classic, sidebar: \"Expiring soon\" under Snoozed, server counter, classic expiring page", () => {
	const l = code("components/dashboard/identity-mailboxes-list.tsx");
	assert.match(l, /expiringCountsPromise:\s*Promise<Record<string, number>>/);
	assert.match(l, /use\(expiringCountsPromise\)\[identity\.id\] \?\? 0/);
	assert.match(l, /\/expiring`/);
	assert.match(l, /Expiring soon/);
	assert.match(l, /currentSlug === "expiring"/);
	assert.ok(l.indexOf("Snoozed (") < l.indexOf("Expiring soon"), "under Snoozed");
	assert.match(l, /expiringCountsPromise=\{expiringCountsPromise\}/, "passed to the per-identity rendering");
	assert.match(code("components/dashboard/workspaces/identity-mailboxes-list-wrapper.tsx"), /expiringCountsPromise=\{fetchExpiringCounts\(\)\}/);
	const p = code(`${PAGES}/expiring/page.tsx`);
	assert.match(p, /async function ClassicExpiringPage/);
	assert.match(p, /isModernUi\(\)\) \? <ModernExpiringPage[^:]*: <ClassicExpiringPage/);
	assert.ok(/<WebmailListLabelSearch/.test(p.slice(p.indexOf("ClassicExpiringPage"), p.indexOf("ModernExpiringPage"))), "classic list");
});

if (failed) {
	console.error(`${failed} failure(s)`);
	process.exit(1);
}
