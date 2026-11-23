// Message attachments: stable links, signed at click time. An attachment opened more than
// 5 minutes after the thread was displayed used to end on "Bad request: Date is too old"
// (S3 URL signed at display time).
// From the repository root:
//   node_modules/.bin/tsx apps/web/test/attachment-links.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	attachmentDisposition,
	attachmentLink,
	attachmentUrls,
	isAttachmentId,
	parseAttachmentMode,
} from "../lib/attachment-links";
import { cidUrlMap } from "../lib/inline-images";

const ID = "111575e0-724f-4e04-b148-892453ebcbd5";
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

test("stable links, no signature in the page", () => {
	assert.equal(attachmentLink(ID), `/api/attachments/${ID}`);
	assert.equal(attachmentLink(ID, "download"), `/api/attachments/${ID}?mode=download`);
	assert.deepEqual(attachmentUrls({ id: ID }), {
		signedUrl: `/api/attachments/${ID}`,
		downloadUrl: `/api/attachments/${ID}?mode=download`,
	});
});

test("unknown id and mode are refused", () => {
	assert.equal(isAttachmentId(ID), true);
	assert.equal(isAttachmentId("../../etc/passwd"), false);
	assert.equal(parseAttachmentMode(null), "open");
	assert.equal(parseAttachmentMode("download"), "download");
	assert.equal(parseAttachmentMode("other"), null);
});

test("download name: ASCII fallback and UTF-8 name, no header injection", () => {
	const header = attachmentDisposition('Devis "é"\r\n.pdf');
	assert.match(header, /^attachment; filename="Devis _e_{3}\.pdf"; filename\*=UTF-8''/);
	assert.ok(!/[\r\n]/.test(header));
	assert.match(attachmentDisposition(null), /filename="attachment"/);
});

test("body images: direct S3 URL, not the route (iframe of the message)", () => {
	const map = cidUrlMap([
		{ id: "1", cid: "<Logo@x>", signedUrl: `/api/attachments/${ID}`, inlineUrl: "https://s3/logo" },
		{ id: "2", cid: "legacy", signedUrl: "https://s3/legacy" },
	]);
	assert.deepEqual(map, { "logo@x": "https://s3/logo", legacy: "https://s3/legacy" });
});

test("the page no longer receives a signed URL for the attachments", () => {
	const body = source("lib/actions/mailbox.ts")
		.split("export async function getSignedUrlsForMessage")[1]
		.split("export const revalidateMailbox")[0];
	assert.match(body, /\.\.\.attachmentUrls\(attachment\)/);
});

test("route: access by RLS, redirect to a fresh S3 URL", () => {
	const route = source("app/api/attachments/[id]/route.ts");
	assert.match(route, /rlsClient\(\)/);
	assert.match(route, /status: 302/);
	assert.match(route, /expiresIn: SIGNED_URL_SECONDS/);
});

if (failures > 0) {
	console.error(`${failures} test(s) failed`);
	process.exit(1);
}
