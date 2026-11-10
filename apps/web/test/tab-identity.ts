// Title and icon of the tab according to the section, to tell a mail tab from a calendar tab at
// a glance. Every tab used to be called "Kurrier" with the same icon.
// Each section layout exports tabMetadata(section): its own title and its own SVG favicon.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/tab-identity.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TAB_SECTIONS, tabMetadata, tabSectionOf, tabTitle } from "../lib/tab-identity";

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

const web = join(__dirname, "..");
const unified = join(web, "app/[locale]/w/[wPublicId]/dashboard/(unified)");

test("mail: title Mail", () => {
	assert.equal(tabMetadata("mail").title, "Mail");
});
test("calendar: title distinct from the mail", () => {
	assert.equal(tabMetadata("calendar").title, "Calendar");
});
test("mail and calendar do not have the same icon", () => {
	const icon = (s: keyof typeof TAB_SECTIONS) => (tabMetadata(s).icons as any).icon[0].url;
	assert.notEqual(icon("mail"), icon("calendar"));
});
test("sections without an icon keep the favicon of the application", () => {
	assert.equal(tabMetadata("contacts").icons, undefined);
	assert.equal(tabMetadata("drive").icons, undefined);
});
test("each icon exists in public/ and is an SVG", () => {
	for (const s of Object.values(TAB_SECTIONS)) {
		if (!s.icon) continue;
		const file = join(web, "public", s.icon);
		assert.ok(existsSync(file), `${s.icon} missing from public/`);
		assert.match(readFileSync(file, "utf8"), /<svg[\s>]/);
	}
});
test("each section layout exports the tabMetadata of its section", () => {
	const dirs: Record<string, string> = {
		mail: "(mail)",
		calendar: "(calendar)",
		contacts: "(contacts)",
		drive: "(drive)",
		platform: "(platform)",
	};
	for (const [section, dir] of Object.entries(dirs)) {
		const src = readFileSync(join(unified, dir, "layout.tsx"), "utf8");
		assert.ok(
			src.includes(`export const metadata = tabMetadata("${section}")`),
			`${dir}/layout.tsx does not export tabMetadata("${section}")`,
		);
	}
});

const ws = "/en/w/abc/dashboard";
test("modern interface: mail title with folder and unread count", () => {
	assert.equal(tabTitle(`${ws}/mail/id1/inbox`, 3), "(3) Mail - Inbox");
	assert.equal(tabTitle(`${ws}/mail/id1/sent`, 0), "Mail - Sent");
	assert.equal(tabTitle(`${ws}/mail/id1/inbox/search`, 0), "Mail - Search");
	assert.equal(tabTitle(`${ws}/mail/id1/perso-xyz`, 0, "Invoices"), "Mail - Invoices");
	assert.equal(tabTitle(`${ws}/mail`, 0), "Mail");
});
test("modern interface: the other sections keep their name, without a counter", () => {
	// Before: "(3) Kurrier - Mail" on the calendar.
	assert.equal(tabTitle(`${ws}/calendar/xyz`, 3), "Calendar");
	assert.equal(tabTitle(`${ws}/contacts`, 2), "Contacts");
});
test("section from the path", () => {
	assert.equal(tabSectionOf(`${ws}/calendar`), "calendar");
	assert.equal(tabSectionOf(`${ws}/mail/id1/inbox/threads/t1`), "mail");
});

test("the root favicon is no longer a special file of app/ (it would add to the section icon)", () => {
	assert.ok(!existsSync(join(web, "app/favicon.ico")), "app/favicon.ico present");
	assert.ok(existsSync(join(web, "public/favicon.ico")), "public/favicon.ico missing");
	assert.match(readFileSync(join(web, "app/layout.tsx"), "utf8"), /icons:\s*\{\s*icon:\s*\[\{\s*url:\s*"\/favicon\.ico"/);
});

if (failures) {
	console.log(`\n${failures} failing test(s)`);
	process.exit(1);
}
console.log("\nall tests pass");
