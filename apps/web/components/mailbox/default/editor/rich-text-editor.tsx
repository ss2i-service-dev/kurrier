// @ts-nocheck
import "@mantine/tiptap/styles.css";
import { RichTextEditor, Link } from "@mantine/tiptap";
import { useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import { useModernUi } from "@/components/k/ui-context";
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

// A line left empty to space out the mail is an empty paragraph, which TipTap
// serializes as <p></p>. That paragraph has zero height everywhere else (reader,
// Gmail, Outlook): empty lines disappeared when sending and when reopening.
// Stored and sent as <p><br></p> (Gmail's form), read back as <p></p> by the editor.
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
		// Slot of the signature preview, between the text and the quote.
		const [sigSlot, setSigSlot] = useState<HTMLElement | null>(null);
		const [value, setValue] = useState(toStoredHtml(defaultValue));
		const [textValue, setTextValue] = useState("");

		// Modern interface: extended formatting (alignment, colors, highlight, size);
		// the classic interface keeps its original extensions.
		const modern = useModernUi();
		const editor = useEditor({
			immediatelyRender: false,
			// Modern interface: the state of the formatting buttons (bold, italic...)
			// follows the cursor live (Tiptap 3 no longer re-renders by default).
			shouldRerenderOnTransaction: modern,
			parseOptions: { preserveWhitespace: "full" },
			extensions: modern
				? [
						// StarterKit's link would duplicate Mantine's (Link)
						StarterKit.configure({ link: false }),
						Link,
						Image,
						TextStyle,
						Color,
						FontSize,
						Highlight.configure({ multicolor: true }),
						TextAlign.configure({ types: ["heading", "paragraph"] }),
					]
				: [StarterKit, Link, Image],
			// Resuming a draft: the saved body is the initial content.
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
		// Modern interface: formatting bar open or closed (remembered).
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

		// Current mode (chosen in the header) and scope of a reply's quote (last message
		// only by default; resumed draft: its saved choice).
		// The scope is sent with the form (quoteScope) to the worker that builds the quote.
		const [editorMode, setEditorMode] = useState<string>(state.showEditorMode);
		const [quoteScope, setQuoteScope] = useState<QuoteScope>(() => {
			const saved = (state.draftRow?.metaData as any)?.draft?.quoteScope;
			return saved === "thread" ? "thread" : "last";
		});
		const isReply = editorMode === "reply" || editorMode === "replyAll";
		// Forward: the forwarded message is shown and edited like a quote
		// (scope: whole message, never removed).
		const isForward = editorMode === "forward";
		const hasQuote = isReply || isForward;
		// Editable quote (quoteMode auto / custom / none, quoteHtml if custom); resumed
		// draft: saved mode and HTML.
		const [quoteMode, setQuoteMode] = useState<QuoteMode>(() =>
			quoteModeOf((state.draftRow?.metaData as any)?.draft?.quoteMode),
		);
		const [quoteHtml, setQuoteHtml] = useState<string>(
			() => String((state.draftRow?.metaData as any)?.draft?.quoteHtml ?? ""),
		);
		// Changing the scope reloads the quote: confirmation (Mantine modal, not
		// window.confirm) when it was edited by hand.
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
			<KSignatureSlot.Provider value={sigSlot}>
			<div ref={containerRef} className="scroll-mt-[72px]">
				<RichTextEditor
					editor={editor}
					labels={modern ? (K_EDITOR_LABELS as any) : undefined}
					className={
						modern
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
					{/* RFC style: a reply's quote goes above; a forward keeps the text first and the forwarded message below, as when sending. */}
					{state.rfcStyle && !isForward ? quoteEditor : null}
					{modern && formatOpen && <KFormatBar />}
					{modern && <KBubbleBar />}
					<FocusTrap active={focusOnSubject}>
						<RichTextEditor.Content className={modern ? "k-editor-content" : "prose min-h-96 text-sm p-2 leading-5"} />
					</FocusTrap>
					{modern && !(state.rfcStyle && isForward) && <div ref={setSigSlot} className="k-sig-slot" />}
					{!state.rfcStyle || isForward ? quoteEditor : null}
					{modern && state.rfcStyle && isForward && <div ref={setSigSlot} className="k-sig-slot" />}
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
