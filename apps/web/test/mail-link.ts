// Editeur du mail : lien automatique. Samuel le 23/11/2026 : « je tape mon mail, je mets une
// adresse mail et ça me met tout le reste de la ligne comme lien ».
// Cause : le Link de TipTap est « inclusive » des que l'autolink est actif (inclusive() renvoie
// options.autolink) ; le texte tape juste apres un lien prend donc la marque du lien.
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
//   1) schema : la marque link de l'editeur (lib/mail-link.ts) n'est plus inclusive ;
//   2) saisie : apres « dev@ss2i-services.fr » lie, « en destinataire » tape au bout reste du texte ;
//   3) cablage : rich-text-editor.tsx utilise MailLink dans les deux interfaces, et StarterKit
//      n'y ajoute pas son propre Link (inclusif) dans l'interface classique.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/mail-link.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSchema } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { MailLink } from "../lib/mail-link";

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

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const schema = getSchema([StarterKit.configure({ link: false }), MailLink]);

test("la marque link n'est pas inclusive", () => {
	assert.equal(schema.marks.link.spec.inclusive, false);
});

test("le texte tape apres une adresse liee n'est pas un lien", () => {
	const link = schema.marks.link.create({ href: "mailto:dev@ss2i-services.fr" });
	const doc = schema.node("doc", null, [
		schema.node("paragraph", null, [
			schema.text("Pensez à mettre "),
			schema.text("dev@ss2i-services.fr", [link]),
		]),
	]);
	let state = EditorState.create({ doc, schema });
	state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
	state = state.apply(state.tr.insertText(" en destinataire"));
	const linked: string[] = [];
	state.doc.descendants((node) => {
		if (node.isText && node.marks.some((m) => m.type.name === "link")) linked.push(node.text!);
	});
	assert.deepEqual(linked, ["dev@ss2i-services.fr"]);
});

test("l'editeur utilise MailLink, sans le Link de StarterKit", () => {
	const editor = src("components/mailbox/default/editor/rich-text-editor.tsx");
	assert.match(editor, /from "@\/lib\/mail-link"/);
	assert.doesNotMatch(editor, /import \{[^}]*\bLink\b[^}]*\} from "@mantine\/tiptap"/);
	assert.doesNotMatch(editor, /\[\s*StarterKit\s*,/, "StarterKit sans configure({ link: false }) ajoute un Link inclusif");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les controles passent");
