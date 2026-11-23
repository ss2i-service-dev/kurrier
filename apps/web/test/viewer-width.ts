// The attachment viewer uses the whole width of the screen: the previews used to be capped
// (CSV 1400 px, zip 900, PDF 1000, pptx 1100), which left empty margins on a wide screen
// and pushed the columns of a table out of view.
// From the repository root:
//   node_modules/.bin/tsx apps/web/test/viewer-width.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

test("no preview panel has a capped width", () => {
	for (const file of ["text-preview", "zip-preview", "pptx-preview"]) {
		assert.doesNotMatch(source(`components/k/${file}.tsx`), /max-w-\[(900|1000|1100|1400)px\]/, file);
	}
	assert.doesNotMatch(source("components/k/attachments.tsx"), /max-w-\[1000px\]/);
});

test("the margin of the arrows is only kept when there are arrows", () => {
	assert.match(source("components/k/attachments.tsx"), /previewable\.length > 1 \? "px-16" : "px-4"/);
});

if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
