"use client";
import { useMemo } from "react";
import DOMPurify from "dompurify";
import { MessageEntity } from "@db";
import { buildQuote, formatQuoteDate, type QuoteScope } from "@common/compose";

// ss2i : en style RFC, la reponse part sous la citation ; l'editeur montre donc la
// citation (non modifiable) au-dessus de la zone de saisie, telle que le worker
// l'assemblera (meme fonction buildQuote, meme portee « dernier message / tout le fil »).
// Meme date aussi : formatQuoteDate dans le fuseau MAIL_TIMEZONE.
export default function ReplyQuotePreview({
	message,
	quoteScope,
	timeZone,
}: {
	message: MessageEntity;
	quoteScope: QuoteScope;
	// MAIL_TIMEZONE (publicConfig) : le meme fuseau que le worker.
	timeZone?: string | null;
}) {
	const html = useMemo(() => {
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
			{ quoteScope, rfcStyle: true },
		);
		return typeof window !== "undefined" ? DOMPurify.sanitize(quote.html) : "";
	}, [message, quoteScope, timeZone]);

	return (
		<div className="px-3 pt-2">
			<div className="text-xs text-neutral-500 mb-1">
				Quoted message (sent above your reply,{" "}
				{quoteScope === "last" ? "last message only" : "whole thread"})
			</div>
			<div
				className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 p-2 text-sm text-neutral-700 dark:text-neutral-300 max-h-64 overflow-auto [&_img]:max-w-full"
				dangerouslySetInnerHTML={{ __html: html }}
			/>
		</div>
	);
}
