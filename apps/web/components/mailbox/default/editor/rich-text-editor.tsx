// @ts-nocheck
import "@mantine/tiptap/styles.css";
import { RichTextEditor, Link } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";

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

export const TextEditor = forwardRef<TextEditorHandle, TextEditorProps>(
	({ name, defaultValue = "", onChange }, ref) => {
		const containerRef = useRef<HTMLDivElement>(null);
		const [value, setValue] = useState(defaultValue);
		const [textValue, setTextValue] = useState("");

		const editor = useEditor({
			immediatelyRender: false,
			parseOptions: { preserveWhitespace: "full" },
			extensions: [StarterKit, Link, Image],
			// ss2i : reprise d'un brouillon, le corps enregistre est le contenu initial.
			content: defaultValue,
			onCreate: ({ editor }) => {
				setTextValue(editor.getText().trim());
				setValue(editor.getHTML().trim());
			},
			onUpdate: ({ editor }) => {
				setTextValue(editor.getText().trim());
				setValue(editor.getHTML().trim());
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
				title: "Reload the quoted message?",
				children: "Changing the quote scope discards your edits to the quoted message.",
				labels: { confirm: "Discard edits", cancel: "Keep editing" },
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
			<div ref={containerRef} className="scroll-mt-[72px]">
				<RichTextEditor
					editor={editor}
					className={
						!state.message
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
					<FocusTrap active={focusOnSubject}>
						<RichTextEditor.Content className="prose min-h-96 text-sm p-2 leading-5" />
					</FocusTrap>
					{!state.rfcStyle || isForward ? quoteEditor : null}
					<EditorFooter />
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
		);
	},
);

TextEditor.displayName = "TextEditor";
