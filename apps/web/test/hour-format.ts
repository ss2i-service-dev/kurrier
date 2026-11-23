// Option "Times in 24-hour format": the invitation card shows "13:30" when it is on, the format
// of the browser locale (12 h for en-US) when it is off, the default.
// From the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/hour-format.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hourOptions } from "../lib/hour-format";

const web = join(__dirname, "..");
const source = (path: string) => readFileSync(join(web, path), "utf8");

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

const at = new Date(Date.UTC(2026, 10, 19, 13, 30));

test("option off (default): the format of the locale, 12 h for en-US", () => {
	const text = new Intl.DateTimeFormat("en-US", { ...hourOptions(false), timeZone: "UTC" }).format(at);
	assert.match(text, /1:30\s?PM/);
});

test("option on: 24 h whatever the locale, never AM/PM", () => {
	for (const locale of ["en-US", "en-GB", "fr-FR", "en-CA"]) {
		const text = new Intl.DateTimeFormat(locale, { ...hourOptions(true), timeZone: "UTC" }).format(at);
		assert.match(text, /^13[:h]30$/, `${locale}: ${text}`);
	}
	const morning = new Date(Date.UTC(2026, 10, 19, 9, 5));
	assert.match(new Intl.DateTimeFormat("en-US", { ...hourOptions(true), timeZone: "UTC" }).format(morning), /^09:05$/);
});

test("card and threads: the option is read on the server and given to the card", () => {
	const card = source("components/mailbox/default/render-invite.tsx");
	assert.match(card, /hour24 = false/);
	assert.match(card, /\.\.\.hourOptions\(hour24\)/);
	assert.match(card, /new Intl\.DateTimeFormat\(undefined, hourOptions\(hour24\)\)/);
	for (const file of ["components/k/thread-item.tsx", "components/mailbox/default/thread-item.tsx"]) {
		const item = source(file);
		assert.match(item, /hour24Enabled\(\)/, file);
		assert.match(item, /hour24=\{hour24\}/, file);
	}
});

test("preference stored per user, off by default, and shown in the settings", () => {
	const action = source("lib/actions/hour-format.ts");
	assert.match(action, /pref24HourTime/);
	assert.match(action, /coalesce\(\([^)]*pref24HourTime[^)]*\)::boolean, false\)/);
	assert.match(source("components/mailbox/settings/settings-unread-panel.tsx"), /setHour24Enabled/);
	assert.match(
		source("app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/settings/page.tsx"),
		/hour24=\{hour24\}/,
	);
});

if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
