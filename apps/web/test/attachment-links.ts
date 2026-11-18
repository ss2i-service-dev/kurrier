// Pieces jointes d'un message : liens stables signes au clic, apercu des pptx.
// Hugo le 18/11/2026 : un pptx ouvert plus de 5 minutes apres l'affichage du fil donnait
// « Bad request: Date is too old » (URL S3 signee a l'affichage).
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/attachment-links.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	attachmentLink,
	attachmentUrls,
	canPreviewPptx,
	isAttachmentId,
	parseAttachmentMode,
	PPTX_PREVIEW_MAX_BYTES,
} from "../lib/attachment-links";
import { cidUrlMap } from "../lib/inline-images";

const ID = "111575e0-724f-4e04-b148-892453ebcbd5";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const web = join(__dirname, "..");
const source = (path: string) => readFileSync(join(web, path), "utf8");

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};

test("liens stables, sans signature dans la page", () => {
	assert.equal(attachmentLink(ID), `/api/attachments/${ID}`);
	assert.equal(attachmentLink(ID, "download"), `/api/attachments/${ID}?mode=download`);
	assert.equal(attachmentLink(ID, "content"), `/api/attachments/${ID}?mode=content`);
});

test("identifiant et mode inconnus refuses", () => {
	assert.equal(isAttachmentId(ID), true);
	assert.equal(isAttachmentId("../../etc/passwd"), false);
	assert.equal(parseAttachmentMode(null), "open");
	assert.equal(parseAttachmentMode("download"), "download");
	assert.equal(parseAttachmentMode("autre"), null);
});

test("apercu reserve aux pptx de taille raisonnable", () => {
	assert.equal(canPreviewPptx({ filenameOriginal: "a.bin", contentType: PPTX, sizeBytes: 10 }), true);
	assert.equal(canPreviewPptx({ filenameOriginal: "A.PPTX", contentType: "application/octet-stream" }), true);
	assert.equal(canPreviewPptx({ filenameOriginal: "a.ppt", contentType: "application/vnd.ms-powerpoint" }), false);
	assert.equal(canPreviewPptx({ filenameOriginal: "a.pdf", contentType: "application/pdf" }), false);
	assert.equal(canPreviewPptx({ filenameOriginal: "a.pptx", sizeBytes: PPTX_PREVIEW_MAX_BYTES + 1 }), false);
});

test("images du corps : URL S3 directe, pas la route (iframe du message)", () => {
	const map = cidUrlMap([
		{ id: "1", cid: "<Logo@x>", signedUrl: `/api/attachments/${ID}`, inlineUrl: "https://s3/logo" },
		{ id: "2", cid: "ancien", signedUrl: "https://s3/ancien" },
	]);
	assert.deepEqual(map, { "logo@x": "https://s3/logo", ancien: "https://s3/ancien" });
});

test("la page ne recoit plus d'URL signee pour les pieces jointes", () => {
	const body = source("lib/actions/mailbox.ts").split("export async function getSignedUrlsForMessage")[1].split("export const revalidateMailbox")[0];
	assert.match(body, /\.\.\.attachmentUrls\(attachment\)/);
	assert.deepEqual(attachmentUrls({ id: ID, filenameOriginal: "a.pdf" }), {
		signedUrl: `/api/attachments/${ID}`,
		downloadUrl: `/api/attachments/${ID}?mode=download`,
		contentUrl: undefined,
		textUrl: undefined,
		zipUrl: undefined,
	});
});

test("octets du pptx jamais interpretables sur l'origine de l'application", () => {
	const route = source("app/api/attachments/[id]/route.ts");
	assert.match(route, /"Content-Type": "application\/octet-stream"/);
	assert.match(route, /"X-Content-Type-Options": "nosniff"/);
	assert.match(route, /sandbox/);
	assert.match(route, /canPreviewPptx\(attachment\)/);
});

test("medias externes du pptx bloques", () => {
	assert.match(source("components/k/pptx-preview.tsx"), /externalMedia: "block"/);
});

if (failures > 0) {
	console.error(`${failures} test(s) en echec`);
	process.exit(1);
}
