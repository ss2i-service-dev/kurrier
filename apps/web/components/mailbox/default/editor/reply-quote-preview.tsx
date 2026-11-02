"use client";
import { useMemo } from "react";
import DOMPurify from "dompurify";
import { MessageEntity } from "@db";
import { buildQuote, type QuoteScope } from "@common/compose";

// ss2i : en style RFC, la reponse part sous la citation ; l'editeur montre donc la
// citation (non modifiable) au-dessus de la zone de saisie, telle que le worker
// l'assemblera (meme fonction buildQuote, meme portee « dernier message / tout le fil »).
// Seule la date peut differer d'un cheveu : mise en forme ici par le navigateur, la-bas
// par le serveur.
export default function ReplyQuotePreview({
	message,
	quoteScope,
}: {
	message: MessageEntity;
	quoteScope: QuoteScope;
}) {
	const html = useMemo(() => {
		const raw = (message.date ?? message.createdAt) as Date | string | null;
		const dateLabel = raw
			? new Date(raw).toLocaleString(undefined, {
					year: "numeric",
					month: "short",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
				})
			: "";
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
	}, [message, quoteScope]);

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
