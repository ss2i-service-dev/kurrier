// @ts-nocheck
import "@mantine/tiptap/styles.css";
import { RichTextEditor, Link } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { useNouvelle } from "@/components/k/ui-context";
import { K_EDITOR_LABELS, KBubbleBar, KFormatBar } from "@/components/k/format-toolbar";

import React, {
	forwardRef,
	useImperativeHandle,
	useRef,
	useState,
} from "react";

export type TextEditorHandle = {
	focus: (where?: "start" | "end") => void;
	getElement: () => HTMLElement | null;
	getHTML: () => string;
};

type TextEditorProps = {
	name?: string;
	defaultValue?: string;
	onChange?: (html: string) => void;
};

import { Temporal } from "@js-temporal/polyfill";
import EditorHeader from "@/components/mailbox/default/editor/editor-header";
import EditorFooter from "@/components/mailbox/default/editor/editor-footer";
import ReplyQuoteEditor from "@/components/mailbox/default/editor/reply-quote-editor";
import { quoteModeOf, quoteScopeOf, type QuoteMode, type QuoteScope } from "@common/compose";
import { modals } from "@mantine/modals";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import { MessageEntity } from "@db";
import { FocusTrap } from "@mantine/core";
import { KSignatureSlot } from "@/components/k/signature-slot";
import { imageFileToDataUrl, pastedImageFiles } from "@/lib/paste-image";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";

// ss2i : l'extension Image de Tiptap ecarte les images data: par defaut (allowBase64) :
// une image collee, celle d'un brouillon repris ou d'une signature disparaissait.
const MailImage = Image.configure({ allowBase64: true });

// ss2i : image du presse-papiers ou deposee, inseree dans le corps a la position voulue.
// Le curseur repart sous l'image : laissee selectionnee, la frappe suivante (ou un second
// collage) la remplacait.
function insertImageFiles(view: any, files: File[], pos?: number) {
	(async () => {
		for (const file of files) {
			let src: string;
			try {
				src = await imageFileToDataUrl(file);
			} catch {
				continue;
			}
			if (view.isDestroyed) return;
			const { schema } = view.state;
			const node = schema.nodes.image?.create({ src, alt: file.name || "image" });
			if (!node) return;
			let tr = view.state.tr;
			if (typeof pos === "number") {
				const at = Math.max(0, Math.min(pos, tr.doc.content.size));
				tr = tr.setSelection(TextSelection.near(tr.doc.resolve(at)));
			}
			tr = tr.replaceSelectionWith(node, false);
			let end = tr.selection instanceof NodeSelection ? tr.selection.to : tr.selection.from;
			if (!(tr.selection instanceof NodeSelection)) {
				view.dispatch(tr.scrollIntoView());
				if (typeof pos === "number") pos = tr.selection.from;
				continue;
			}
			const next = tr.doc.nodeAt(end);
			if (!next || !next.isTextblock) tr = tr.insert(end, schema.nodes.paragraph.create());
			tr = tr.setSelection(TextSelection.create(tr.doc, end + 1));
			view.dispatch(tr.scrollIntoView());
			if (typeof pos === "number") pos = end + 1;
		}
		view.focus();
	})();
}

function formatWhen(d: Date) {
	return Temporal.Instant.from(d.toISOString())
		.toZonedDateTimeISO(Temporal.Now.timeZoneId())
		.toLocaleString("en-GB", {
			day: "2-digit",
			month: "short",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		});
}

// ss2i : une ligne laissee vide pour aerer le mail est un paragraphe vide, que TipTap
// serialise en <p></p>. Ce paragraphe a une hauteur nulle partout ailleurs (lecteur,
// Gmail, Outlook) : les lignes vides disparaissaient a l'envoi et a la reouverture.
// Stocke et envoye en <p><br></p> (forme de Gmail), relu en <p></p> par l'editeur.
const EMPTY_P = /<p(\s[^>]*)?><\/p>/g;
const EMPTY_P_BR = /<p(\s[^>]*)?>\s*<br\s*\/?>\s*<\/p>/g;
export function toStoredHtml(html: string): string {
	return html.replace(EMPTY_P, (_m, attrs = "") => `<p${attrs}><br></p>`);
}
export function fromStoredHtml(html: string): string {
	return html.replace(EMPTY_P_BR, (_m, attrs = "") => `<p${attrs}></p>`);
}

export const TextEditor = forwardRef<TextEditorHandle, TextEditorProps>(
	({ name, defaultValue = "", onChange }, ref) => {
		const containerRef = useRef<HTMLDivElement>(null);
		// ss2i (Outlook) : emplacement de l'apercu de signature, entre le texte et la citation.
		const [sigSlot, setSigSlot] = useState<HTMLElement | null>(null);
		const [value, setValue] = useState(toStoredHtml(defaultValue));
		const [textValue, setTextValue] = useState("");

		// ss2i : nouvelle interface, mise en forme etendue (alignement, couleurs,
		// surlignage, taille) ; l'interface classique garde ses extensions d'origine.
		const nouvelle = useNouvelle();
		const editor = useEditor({
			immediatelyRender: false,
			// ss2i : nouvelle interface, l'etat des boutons de mise en forme (gras,
			// italique...) suit le curseur en direct (Tiptap 3 ne redessine plus par defaut).
			shouldRerenderOnTransaction: nouvelle,
			parseOptions: { preserveWhitespace: "full" },
			extensions: nouvelle
				? [
						// le lien de StarterKit ferait doublon avec celui de Mantine (Link)
						StarterKit.configure({ link: false }),
						Link,
						MailImage,
						TextStyle,
						Color,
						FontSize,
						Highlight.configure({ multicolor: true }),
						TextAlign.configure({ types: ["heading", "paragraph"] }),
					]
				: [StarterKit, Link, MailImage],
			editorProps: {
				handlePaste: (view, event) => {
					const files = pastedImageFiles(event.clipboardData, { ignoreIfText: true });
					if (!files.length) return false;
					event.preventDefault();
					insertImageFiles(view, files);
					return true;
				},
				handleDrop: (view, event, _slice, moved) => {
					if (moved) return false;
					const files = pastedImageFiles(event.dataTransfer, { ignoreIfText: false });
					if (!files.length) return false;
					event.preventDefault();
					const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
					insertImageFiles(view, files, at?.pos);
					return true;
				},
			},
			// ss2i : reprise d'un brouillon, le corps enregistre est le contenu initial.
			content: fromStoredHtml(defaultValue),
			onCreate: ({ editor }) => {
				setTextValue(editor.getText().trim());
				setValue(toStoredHtml(editor.getHTML().trim()));
			},
			onUpdate: ({ editor }) => {
				setTextValue(editor.getText().trim());
				setValue(toStoredHtml(editor.getHTML().trim()));
			},
		});

		useImperativeHandle(
			ref,
			() => ({
				focus: (where = "end") => {
					if (!editor) return;
					editor.commands.focus(where);
				},
				getElement: () => containerRef.current,
				getHTML: () => value,
			}),
			[editor, value],
		);

		const { state } = useDynamicContext<{
			isPending: boolean;
			message: MessageEntity;
			showEditorMode: "reply" | "forward" | "compose";
			rfcStyle?: boolean;
			draftRow?: MessageEntity | null;
			publicConfig?: { MAIL_TIMEZONE?: string | null };
		}>();

		const [focusOnSubject, setFocusOnSubject] = useState<boolean>(false);
		// ss2i : nouvelle interface, barre de mise en forme ouverte ou fermee (memorisee).
		const [formatOpen, setFormatOpen] = useState<boolean>(() => {
			if (typeof window === "undefined") return true;
			try {
				return localStorage.getItem("k-format-bar") !== "0";
			} catch {
				return true;
			}
		});
		const toggleFormat = () =>
			setFormatOpen((v) => {
				try {
					localStorage.setItem("k-format-bar", v ? "0" : "1");
				} catch {}
				return !v;
			});

		// ss2i : mode courant (choisi dans l'en-tete) et portee de la citation d'une reponse
		// (dernier message seulement par defaut ; brouillon repris : son choix enregistre).
		// La portee part avec le formulaire (quoteScope) jusqu'au worker qui cite.
		const [editorMode, setEditorMode] = useState<string>(state.showEditorMode);
		const [quoteScope, setQuoteScope] = useState<QuoteScope>(() => {
			const saved = (state.draftRow?.metaData as any)?.draft?.quoteScope;
			return saved === "thread" ? "thread" : "last";
		});
		const isReply = editorMode === "reply" || editorMode === "replyAll";
		// Transfert : le message transfere s'affiche et se modifie comme une citation
		// (portee : message entier, jamais supprime).
		const isForward = editorMode === "forward";
		const hasQuote = isReply || isForward;
		// Citation modifiable (quoteMode auto / custom / none, quoteHtml si custom) ; brouillon
		// repris : mode et HTML enregistres.
		const [quoteMode, setQuoteMode] = useState<QuoteMode>(() =>
			quoteModeOf((state.draftRow?.metaData as any)?.draft?.quoteMode),
		);
		const [quoteHtml, setQuoteHtml] = useState<string>(
			() => String((state.draftRow?.metaData as any)?.draft?.quoteHtml ?? ""),
		);
		// Changer de portee recharge la citation : confirmation (modal Mantine, pas
		// window.confirm) quand elle a ete modifiee a la main.
		const changeQuoteScope = (v: string) => {
			const next = quoteScopeOf(v);
			if (quoteMode !== "custom") return setQuoteScope(next);
			modals.openConfirmModal({
				title: nouvelle ? "Recharger le message cité ?" : "Reload the quoted message?",
				children: nouvelle ? "Changer la portée de la citation annule vos modifications du message cité." : "Changing the quote scope discards your edits to the quoted message.",
				labels: nouvelle ? { confirm: "Annuler mes modifications", cancel: "Continuer" } : { confirm: "Discard edits", cancel: "Keep editing" },
				onConfirm: () => {
					setQuoteMode("auto");
					setQuoteHtml("");
					setQuoteScope(next);
				},
			});
		};
		const quoteEditor =
			hasQuote && state.message ? (
				<ReplyQuoteEditor
					message={state.message}
					forward={isForward}
					quoteScope={isForward ? "thread" : quoteScope}
					timeZone={state.publicConfig?.MAIL_TIMEZONE}
					rfcStyle={Boolean(state.rfcStyle)}
					mode={quoteMode}
					customHtml={quoteHtml}
					onChange={(m, html) => {
						setQuoteMode(m);
						setQuoteHtml(m === "custom" ? html : "");
					}}
				/>
			) : null;

		return (
			<KSignatureSlot.Provider value={sigSlot}>
			<div ref={containerRef} className="scroll-mt-[72px]">
				<RichTextEditor
					editor={editor}
					labels={nouvelle ? (K_EDITOR_LABELS as any) : undefined}
					className={
						nouvelle
							? "k-editor !border-0 !rounded-none !bg-transparent"
							: !state.message
								? "!border-0 -mt-4"
								: "!border !rounded-t-md !border-neutral-200"
					}
				>
					<EditorHeader
						focusOnSubject={setFocusOnSubject}
						onModeChange={setEditorMode}
						quoteScope={quoteScope}
						onQuoteScopeChange={changeQuoteScope}
					/>
					{/* Style RFC : citation d'une reponse au-dessus ; un transfert garde le texte en tete et le message transfere dessous, comme a l'envoi. */}
					{state.rfcStyle && !isForward ? quoteEditor : null}
					{nouvelle && formatOpen && <KFormatBar />}
					{nouvelle && <KBubbleBar />}
					<FocusTrap active={focusOnSubject}>
						<RichTextEditor.Content className={nouvelle ? "k-editor-content" : "prose min-h-96 text-sm p-2 leading-5"} />
					</FocusTrap>
					{nouvelle && !(state.rfcStyle && isForward) && <div ref={setSigSlot} className="k-sig-slot" />}
					{!state.rfcStyle || isForward ? quoteEditor : null}
					{nouvelle && state.rfcStyle && isForward && <div ref={setSigSlot} className="k-sig-slot" />}
					<EditorFooter formatOpen={formatOpen} onToggleFormat={toggleFormat} />
				</RichTextEditor>

				{/*<span className="text-xs text-neutral-500">*/}
				{/*	Press Shift + Enter for a line break*/}
				{/*</span>*/}
				{name ? (
					<>
						<input type="hidden" name={name} value={value} readOnly />
						<input type="hidden" name={`text`} value={textValue} readOnly />
					</>
				) : null}
				<input type="hidden" name="quoteScope" value={isReply ? quoteScope : ""} readOnly />
				<input type="hidden" name="quoteMode" value={hasQuote && state.message ? quoteMode : ""} readOnly />
				<input type="hidden" name="quoteHtml" value={hasQuote && quoteMode === "custom" ? quoteHtml : ""} readOnly />
			</div>
			</KSignatureSlot.Provider>
		);
	},
);

TextEditor.displayName = "TextEditor";
