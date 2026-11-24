// Apercu d'un mail joint (.eml) dans la visionneuse.
// Hugo le 24/11/2026 : « on a des pieces jointes en .eml souvent, mais on peut pas les visualiser ».
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/eml-preview.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { attachmentUrls, parseAttachmentMode } from "../lib/attachment-links";
import { canPreviewEml, emlPartLink, emlPartName, parsePartIndex } from "../lib/eml-preview";
import { emlPart, parseEmlPreview } from "../lib/eml-parse";
import { isMsgFile, sniffImage } from "../lib/msg-parse";

const ID = "111575e0-724f-4e04-b148-892453ebcbd5";
const source = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn]);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n% test\n");

const eml = Buffer.from(
	[
		"From: =?UTF-8?Q?Beno=C3=AEt_Martin?= <benoit@client.fr>",
		"To: Hugo <hugo@ss2i-digital.fr>, Samuel <samuel@ss2i-digital.fr>",
		"Cc: compta@client.fr",
		"Subject: =?UTF-8?Q?Devis_r=C3=A9vis=C3=A9?=",
		"Date: Mon, 23 Nov 2026 14:05:00 +0100",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="mix"',
		"",
		"--mix",
		'Content-Type: multipart/related; boundary="rel"',
		"",
		"--rel",
		"Content-Type: text/html; charset=utf-8",
		"Content-Transfer-Encoding: quoted-printable",
		"",
		"<p>Bonjour, voici le devis r=C3=A9vis=C3=A9.</p><img src=3D\"cid:logo@client\">",
		"--rel",
		"Content-Type: image/png",
		"Content-ID: <logo@client>",
		"Content-Disposition: inline",
		"Content-Transfer-Encoding: base64",
		"",
		PNG.toString("base64"),
		"--rel--",
		"--mix",
		'Content-Type: application/pdf; name="devis.pdf"',
		'Content-Disposition: attachment; filename="devis.pdf"',
		"Content-Transfer-Encoding: base64",
		"",
		PDF.toString("base64"),
		"--mix",
		"Content-Type: message/rfc822",
		"",
		"From: a@b.fr",
		"Subject: mail transfere",
		"",
		"corps",
		"--mix--",
		"",
	].join("\r\n"),
);

test("un .eml ou un message/rfc822 est previsualisable", () => {
	assert.equal(canPreviewEml({ filenameOriginal: "Devis.EML" }), true);
	assert.equal(canPreviewEml({ filenameOriginal: "sans-nom", contentType: "message/rfc822; charset=utf-8" }), true);
	assert.equal(canPreviewEml({ filenameOriginal: "a.pdf", contentType: "application/pdf" }), false);
	assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.eml" }).emlUrl, `/api/attachments/${ID}?mode=message`);
	assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.pdf" }).emlUrl, undefined);
	assert.equal(parseAttachmentMode("message"), "message");
	assert.equal(parseAttachmentMode("part"), "part");
});

test("numero de piece interne : chiffres seulement", () => {
	assert.equal(parsePartIndex("2"), 2);
	assert.equal(parsePartIndex(null), null);
	assert.equal(parsePartIndex("-1"), null);
	assert.equal(parsePartIndex("1e3"), null);
	assert.equal(emlPartLink(ID, 3), `/api/attachments/${ID}?mode=part&part=3`);
	assert.equal(emlPartName("", "message/rfc822", 1), "message-2.eml");
	assert.equal(emlPartName(null, "image/png", 0), "piece-jointe-1.png");
});

test("en-tetes, corps, image inline et pieces jointes decodes", async () => {
	const p = await parseEmlPreview(eml);
	assert.equal(p.subject, "Devis révisé");
	assert.deepEqual(p.from, { value: [{ name: "Benoît Martin", address: "benoit@client.fr" }] });
	assert.equal(p.to?.value.length, 2);
	assert.equal(p.cc?.value[0].address, "compta@client.fr");
	assert.equal(p.date, "2026-11-23T13:05:00.000Z");
	assert.match(p.html ?? "", /devis révisé/);
	// L'image citee dans le HTML part en data: et ne figure pas dans la liste.
	assert.match(p.cidUrls["logo@client"], /^data:image\/png;base64,/);
	assert.deepEqual(
		p.attachments.map((a) => [a.filename, a.contentType]),
		[
			["devis.pdf", "application/pdf"],
			["message-3.eml", "message/rfc822"],
		],
	);
	const part = await emlPart(eml, p.attachments[0].index);
	assert.equal(part?.filename, "devis.pdf");
	assert.equal(part?.content.toString(), PDF.toString());
	assert.equal(await emlPart(eml, 99), null);
});

test("mail en texte seul", async () => {
	const p = await parseEmlPreview(Buffer.from("From: a@b.fr\r\nSubject: Salut\r\n\r\nLigne 1\r\nLigne 2\r\n"));
	assert.equal(p.html, null);
	assert.match(p.text ?? "", /Ligne 1\nLigne 2/);
	assert.deepEqual(p.attachments, []);
});

test("piece interne toujours servie en telechargement, jamais interpretee", () => {
	const route = source("app/api/attachments/[id]/route.ts");
	const block = route.split('if (mode === "message" || mode === "part")')[1].split('if (mode === "content")')[0];
	assert.match(block, /"Content-Type": "application\/octet-stream"/);
	assert.match(block, /attachmentDisposition\(found\.filename\)/);
	assert.match(block, /sandbox/);
	assert.match(block, /EML_PREVIEW_MAX_BYTES/);
});

// Hugo le 24/11/2026 : les .msg d'Outlook (218 recus) ont le meme apercu. Verifie a la main sur
// 5 .msg recus (HTML direct ou extrait du RTF, images inline sans type reconnues) ; pas de
// fichier d'exemple ici, ils contiennent de vrais mails.
test("un .msg d'Outlook passe par le meme apercu, reconnu a sa signature", async () => {
	assert.equal(canPreviewEml({ filenameOriginal: "Relance.MSG" }), true);
	assert.equal(canPreviewEml({ filenameOriginal: "sans-nom", contentType: "application/vnd.ms-outlook" }), true);
	assert.equal(attachmentUrls({ id: ID, filenameOriginal: "a.msg" }).emlUrl, `/api/attachments/${ID}?mode=message`);
	const cfbf = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(504)]);
	assert.equal(isMsgFile(cfbf), true);
	assert.equal(isMsgFile(eml), false);
	// Conteneur illisible : erreur, que la route transforme en « Ce mail n'a pas pu etre lu ».
	await assert.rejects(async () => parseEmlPreview(cfbf));
	assert.match(source("lib/eml-parse.ts"), /if \(isMsgFile\(source\)\) return parseMsgPreview\(source\)/);
	assert.match(source("lib/eml-parse.ts"), /if \(isMsgFile\(source\)\) return msgPart\(source, index\)/);
});

test("image inline d'Outlook sans type reconnue a sa signature", () => {
	assert.equal(sniffImage(PNG), "image/png");
	assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	assert.equal(sniffImage(Buffer.from("GIF89a")), "image/gif");
	assert.equal(sniffImage(PDF), null);
});

test("la visionneuse ouvre le .eml dans le lecteur des mails", () => {
	const viewer = source("components/k/attachments.tsx");
	assert.match(viewer, /!!a\.emlUrl/);
	assert.match(viewer, /<EmlPreview/);
	assert.match(source("components/k/eml-preview.tsx"), /<EmailViewer/);
	assert.match(source("components/mailbox/default/message-attachments.tsx"), /a\.emlUrl/);
});

(async () => {
	let failed = 0;
	for (const [name, fn] of tests) {
		try {
			await fn();
			console.log(`ok   ${name}`);
		} catch (e) {
			failed++;
			console.error(`FAIL ${name}\n`, e);
		}
	}
	if (failed) process.exit(1);
})();
