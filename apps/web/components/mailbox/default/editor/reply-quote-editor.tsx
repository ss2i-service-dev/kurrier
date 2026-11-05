"use client";
import { useModernUi } from "@/components/k/ui-context";
import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { MessageEntity } from "@db";
import {
	buildQuote,
	formatQuoteDate,
	type QuoteMode,
	type QuoteScope,
} from "@common/compose";
import { BASE_CSS } from "@/components/mailbox/default/email-viewer";

// The quote is rendered in a Shadow DOM with the reader's stylesheet (email-viewer):
// isolated from the page, the Tailwind reset (headings, margins, tables) no longer
// reaches it and the forwarded or quoted message keeps the formatting seen when reading.
const QUOTE_EDIT_CSS = `
.email-root { outline: none; min-height: 2em; padding: 8px; }
`;

// Quote of a reply, editable before sending (to remove the other person's signature,
// useless blocks). The quoted body comes from buildQuote (same function as the worker,
// same scope, same date); a contentEditable div shows it (not TipTap, which would break
// tables from Outlook messages), in a Shadow DOM (see QUOTE_EDIT_CSS). Any edit switches
// to "custom" mode with the resulting HTML; "Restore quote" goes back to the computed
// body, "Don't quote" removes the quote.
// The div is never re-rendered by React: its content is set through the ref
// (initialization, restore, scope change), otherwise the cursor would jump on every keystroke.
export default function ReplyQuoteEditor({
	message,
	forward = false,
	quoteScope,
	timeZone,
	rfcStyle,
	mode,
	customHtml,
	onChange,
}: {
	message: MessageEntity;
	// Forward: "Forwarded message" label, no "Don't quote".
	forward?: boolean;
	quoteScope: QuoteScope;
	// MAIL_TIMEZONE (publicConfig): the same time zone as the worker.
	timeZone?: string | null;
	rfcStyle: boolean;
	mode: QuoteMode;
	// Edited HTML (custom mode), restored from a draft or typed.
	customHtml: string;
	onChange: (mode: QuoteMode, html: string) => void;
}) {
	const modern = useModernUi();
	const [quoteOpen, setQuoteOpen] = useState(false);
	// Editable area, inside the Shadow DOM of the host div.
	const elRef = useRef<HTMLElement | null>(null);
	// Last host div initialized: the callback ref is called again (null, then the element)
	// on every render, the content must only be set on a real mount.
	const initRef = useRef<HTMLDivElement | null>(null);
	// onChange changes on every render; the listener attached once always reads the latest.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;

	const computed = useMemo(() => {
		const dateLabel = formatQuoteDate((message.date ?? message.createdAt) as Date | string | null, timeZone);
		const quote = buildQuote(
			{
				html: message.html,
				text: message.text,
				textAsHtml: message.textAsHtml,
				fromName: message.from?.value?.[0]?.name ?? "",
				fromAddress: message.from?.value?.[0]?.address ?? "",
				dateLabel,
			},
			{ quoteScope, rfcStyle },
		);
		const body = typeof window !== "undefined" ? DOMPurify.sanitize(quote.body) : "";
		return { attribution: quote.attribution, body };
	}, [message, quoteScope, timeZone, rfcStyle]);

	// Auto mode: the computed body follows the scope; the effect is idempotent.
	useEffect(() => {
		if ((mode === "auto" || (forward && mode === "none")) && elRef.current)
			elRef.current.innerHTML = computed.body;
	}, [mode, forward, computed.body]);

	if (mode === "none" && !forward) {
		return (
			<div className="px-3 pt-2 text-xs text-neutral-500">
				{"No quoted message."}{" "}
				<button
					type="button"
					className="underline hover:text-neutral-800"
					onClick={() => onChange("auto", "")}
				>
					{"Add quote"}
				</button>
			</div>
		);
	}

	return (
		// k-quote class, targeted by the modern interface's CSS (no effect elsewhere).
		<div className="k-quote px-3 pt-2">
			<div className="flex items-center gap-3 text-xs text-neutral-500 mb-1">
				<span>
					{forward
						? "Forwarded message (editable)"
						: `Quoted message (editable) - ${quoteScope === "last" ? "last message only" : "whole thread"}`}
				</span>
				<button
					type="button"
					className="underline hover:text-neutral-800 disabled:opacity-40 disabled:no-underline"
					disabled={mode !== "custom"}
					onClick={() => onChange("auto", "")}
				>
					{"Restore quote"}
				</button>
				{!forward && (
					<button
						type="button"
						className="underline hover:text-neutral-800"
						onClick={() => onChange("none", "")}
					>
						{"Don't quote"}
					</button>
				)}
			</div>
			{/* Modern interface: quote collapsed by default (the editing area keeps its
			    place); it stays mounted, so it is still sent. */}
			{modern && (
				<button
					type="button"
					onClick={() => setQuoteOpen((v) => !v)}
					className="k-quote-toggle mb-1 rounded-full border border-k-line-strong px-2.5 py-0.5 text-[12px] text-k-ink-2 hover:bg-k-hover"
					aria-expanded={quoteOpen}
				>
					{quoteOpen ? "Hide quoted message" : "··· Show quoted message"}
				</button>
			)}
			<div hidden={modern && !quoteOpen}>
			<div className="text-xs text-neutral-500 mb-1">{computed.attribution}</div>
			<div
				ref={(host) => {
					// Host div mount: Shadow DOM, reader stylesheet, editable area and initial
					// content (edited HTML of a draft, otherwise computed).
					if (!host) return;
					if (host !== initRef.current) {
						initRef.current = host;
						const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
						shadow.innerHTML = `<style>${BASE_CSS}${QUOTE_EDIT_CSS}</style><article class="email-root" contenteditable="true"></article>`;
						const area = shadow.querySelector("article") as HTMLElement;
						area.innerHTML =
							mode === "custom" && customHtml
								? DOMPurify.sanitize(customHtml)
								: computed.body;
						area.addEventListener("input", () =>
							onChangeRef.current("custom", DOMPurify.sanitize(area.innerHTML)),
						);
					}
					elRef.current = host.shadowRoot?.querySelector("article") ?? null;
				}}
				className="k-quote-area rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 bg-white max-h-96 overflow-auto focus-within:border-neutral-500"
			/>
			</div>
		</div>
	);
}
