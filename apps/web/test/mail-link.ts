// Mail editor: automatic links. Typing an e-mail address and then more text on the same line
// turned the rest of the line into a link.
// Cause: TipTap's Link is "inclusive" as soon as autolink is on (inclusive() returns
// options.autolink), so the text typed right after a link takes the link mark.
//   1) schema: the link mark of the editor (lib/mail-link.ts) is no longer inclusive;
//   2) typing: after a linked "dev@example.org", " as recipient" typed at the end stays plain text;
//   3) wiring: rich-text-editor.tsx uses MailLink in both interfaces, and StarterKit does not add
//      its own (inclusive) Link next to it.
// Run from the repository root:
//   node_modules/.bin/tsx --tsconfig apps/web/tsconfig.json apps/web/test/mail-link.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSchema } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { MailLink } from "../lib/mail-link";

let failed = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failed++;
		console.log(`FAIL  ${label}\n      ${err?.message ?? err}`);
	}
};

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const schema = getSchema([StarterKit.configure({ link: false }), MailLink]);

test("the link mark is not inclusive", () => {
	assert.equal(schema.marks.link.spec.inclusive, false);
});

test("text typed after a linked address is not a link", () => {
	const link = schema.marks.link.create({ href: "mailto:dev@example.org" });
	const doc = schema.node("doc", null, [
		schema.node("paragraph", null, [
			schema.text("Remember to add "),
			schema.text("dev@example.org", [link]),
		]),
	]);
	let state = EditorState.create({ doc, schema });
	state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
	state = state.apply(state.tr.insertText(" as recipient"));
	const linked: string[] = [];
	state.doc.descendants((node) => {
		if (node.isText && node.marks.some((m) => m.type.name === "link")) linked.push(node.text!);
	});
	assert.deepEqual(linked, ["dev@example.org"]);
});

test("the editor uses MailLink, without the Link of StarterKit", () => {
	const editor = src("components/mailbox/default/editor/rich-text-editor.tsx");
	assert.match(editor, /from "@\/lib\/mail-link"/);
	assert.doesNotMatch(editor, /import \{[^}]*\bLink\b[^}]*\} from "@mantine\/tiptap"/);
	assert.doesNotMatch(editor, /\[\s*StarterKit\s*,/, "StarterKit without configure({ link: false }) adds an inclusive Link");
});

if (failed) {
	console.log(`\n${failed} failure(s)`);
	process.exit(1);
}
console.log("\nall checks pass");
