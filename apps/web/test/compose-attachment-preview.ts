// Pieces jointes d'un message en cours de redaction. Samuel le 06/11/2026 : « quand on met une
// piece jointe a un email, il faudrait pouvoir ouvrir la piece jointe telle que la personne va
// la voir, pour etre sur d'avoir mis la bonne ».
// Constat en prod (Chrome, interface classique) : l'envoi du fichier vers S3 echouait (XHR
// statut 0) sans message, le nom restait non cliquable et la piece ne serait pas partie.
// Cause : le client S3 du web signe une somme CRC32 de corps vide dans l'URL d'envoi (SDK AWS
// recent, « WHEN_SUPPORTED »), que Garage refuse ; k-uploads.ts contournait pour la seule
// nouvelle interface.
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/compose-attachment-preview.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3ClientOptions } from "../lib/s3-options";
import { attachmentDisposition, previewModeFor, toPreviewFile } from "../lib/compose-attachment-preview";

let failures = 0;
const test = async (label: string, fn: () => void | Promise<void>) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

const conf = {
	S3_REGION: "garage",
	S3_ENDPOINT: "https://s3.example.test",
	S3_ACCESS_KEY: "AKTEST",
	S3_SECRET_KEY: "secret",
	S3_FORCE_PATH_STYLE: "true",
};

async function main() {
	await test("URL d'envoi signee sans somme de controle (Garage refuse le CRC32 du corps vide)", async () => {
		const client = new S3Client(s3ClientOptions(conf));
		const url = await getSignedUrl(
			client,
			new PutObjectCommand({ Bucket: "b", Key: "private/u/m/f.pdf", ContentType: "application/pdf" }),
			{ expiresIn: 300 },
		);
		assert.ok(!/x-amz-checksum|x-amz-sdk-checksum/i.test(url), `somme de controle dans l'URL : ${url}`);
	});

	await test("le client S3 partage (interface classique) utilise ces options", () => {
		const s = src("lib/create-s3-client.ts");
		assert.match(s, /s3ClientOptions\(/);
	});

	await test("apercu dans la visionneuse pour PDF, image, texte, video, audio", () => {
		const m = (filenameOriginal: string, contentType = "") => previewModeFor({ filenameOriginal, contentType });
		assert.equal(m("devis.pdf", "application/pdf"), "viewer");
		assert.equal(m("devis.PDF"), "viewer");
		assert.equal(m("capture.png", "image/png"), "viewer");
		assert.equal(m("notes.txt", "text/plain"), "viewer");
		assert.equal(m("film.mp4", "video/mp4"), "viewer");
		// Word, Excel, archive : le navigateur ne sait pas les montrer, on ouvre le fichier lui-meme.
		assert.equal(m("offre.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "open");
		assert.equal(m("chiffrage.xlsx"), "open");
		assert.equal(m("lot.zip", "application/zip"), "open");
	});

	await test("piece en redaction convertie pour la visionneuse", () => {
		const f = toPreviewFile(
			{ path: "private/u/m/x.pdf", filenameOriginal: "Devis été.pdf", contentType: "application/pdf", sizeBytes: 391 },
			{ url: "https://s3/x?inline", downloadUrl: "https://s3/x?dl" },
		);
		assert.equal(f.id, "private/u/m/x.pdf");
		assert.equal(f.filenameOriginal, "Devis été.pdf");
		assert.equal(f.signedUrl, "https://s3/x?inline");
		assert.equal(f.downloadUrl, "https://s3/x?dl");
		assert.equal(f.contentType, "application/pdf");
	});

	await test("Content-Disposition du telechargement : nom ASCII de repli et nom UTF-8", () => {
		assert.equal(
			attachmentDisposition('Devis "été".pdf'),
			"attachment; filename=\"Devis _ete_.pdf\"; filename*=UTF-8''Devis%20_%C3%A9t%C3%A9_.pdf",
		);
	});

	await test("cablage : les deux interfaces ouvrent la visionneuse depuis l'editeur", () => {
		const s = src("components/mailbox/default/editor/editor-footer.tsx");
		assert.match(s, /import \{[^}]*\bViewer\b[^}]*\} from "@\/components\/k\/attachments"/);
		assert.match(s, /<Viewer\b/);
		assert.match(s, /createComposeAttachmentPreview\(/);
		// Bouton Apercu explicite, dans chaque interface.
		assert.ok((s.match(/aria-label=\{`Aperçu de \$\{u\.name\}`\}/g) ?? []).length >= 2, "bouton Aperçu dans chaque interface");
	});

	await test("cablage : l'interface classique affiche l'echec d'envoi d'une piece", () => {
		const s = src("components/mailbox/default/editor/editor-footer.tsx");
		const classique = s.slice(s.indexOf("{!nouvelle && uploads.length > 0"));
		assert.match(classique, /u\.status === "error"/);
	});

	if (failures) {
		console.log(`\n${failures} echec(s)`);
		process.exit(1);
	}
	console.log("\ntout est vert");
}

main();
