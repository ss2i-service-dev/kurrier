"use client";
import { useK, useNouvelle } from "@/components/k/ui-context";
import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { MessageEntity } from "@db";
import {
	buildQuote,
	formatQuoteDate,
	type QuoteMode,
	type QuoteScope,
} from "@common/compose";

// ss2i : citation d'une reponse, modifiable avant l'envoi (retirer la signature de
// l'autre, des blocs inutiles). Le corps cite part de buildQuote (meme fonction que le
// worker, meme portee, meme date) ; une div contentEditable le montre (pas TipTap, qui
// casserait les tableaux Outlook). Toute saisie passe en mode « custom » avec le HTML
// obtenu ; « Restore quote » revient au corps calcule, « Don't quote » supprime la citation.
// La div n'est jamais re-rendue par React : son contenu est pose par ref (initialisation,
// restauration, changement de portee), sinon le curseur sauterait a chaque frappe.
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
	// Transfert : libelle « Forwarded message », pas de « Don't quote ».
	forward?: boolean;
	quoteScope: QuoteScope;
	// MAIL_TIMEZONE (publicConfig) : le meme fuseau que le worker.
	timeZone?: string | null;
	rfcStyle: boolean;
	mode: QuoteMode;
	// HTML modifie (mode custom), repris d'un brouillon ou saisi.
	customHtml: string;
	onChange: (mode: QuoteMode, html: string) => void;
}) {
	const t = useK(); // ss2i : francais dans la nouvelle interface
	const nouvelle = useNouvelle();
	const [quoteOpen, setQuoteOpen] = useState(false);
	const elRef = useRef<HTMLDivElement | null>(null);
	// Derniere div initialisee : la ref callback est rappelee (null puis l'element) a chaque
	// rendu, le contenu ne doit etre pose qu'a un vrai montage.
	const initRef = useRef<HTMLDivElement | null>(null);

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

	// Mode auto : le corps calcule suit la portee ; l'effet est idempotent.
	useEffect(() => {
		if ((mode === "auto" || (forward && mode === "none")) && elRef.current)
			elRef.current.innerHTML = computed.body;
	}, [mode, forward, computed.body]);

	if (mode === "none" && !forward) {
		return (
			<div className="px-3 pt-2 text-xs text-neutral-500">
				{t("No quoted message.", "Pas de message cité.")}{" "}
				<button
					type="button"
					className="underline hover:text-neutral-800"
					onClick={() => onChange("auto", "")}
				>
					{t("Add quote", "Ajouter la citation")}
				</button>
			</div>
		);
	}

	return (
		// ss2i : classe k-quote, reperee par le CSS de la nouvelle interface (sans effet ailleurs).
		<div className="k-quote px-3 pt-2">
			<div className="flex items-center gap-3 text-xs text-neutral-500 mb-1">
				<span>
					{forward
						? t("Forwarded message (editable)", "Message transféré (modifiable)")
						: t(`Quoted message (editable) - ${quoteScope === "last" ? "last message only" : "whole thread"}`, `Message cité (modifiable) · ${quoteScope === "last" ? "dernier message" : "tout le fil"}`)}
				</span>
				<button
					type="button"
					className="underline hover:text-neutral-800 disabled:opacity-40 disabled:no-underline"
					disabled={mode !== "custom"}
					onClick={() => onChange("auto", "")}
				>
					{t("Restore quote", "Rétablir la citation")}
				</button>
				{!forward && (
					<button
						type="button"
						className="underline hover:text-neutral-800"
						onClick={() => onChange("none", "")}
					>
						{t("Don't quote", "Ne pas citer")}
					</button>
				)}
			</div>
			{/* ss2i : nouvelle interface, citation repliee par defaut (la zone de saisie
			    garde la place) ; elle reste montee, donc envoyee comme avant. */}
			{nouvelle && (
				<button
					type="button"
					onClick={() => setQuoteOpen((v) => !v)}
					className="k-quote-toggle mb-1 rounded-full border border-k-line-strong px-2.5 py-0.5 text-[12px] text-k-ink-2 hover:bg-k-hover"
					aria-expanded={quoteOpen}
				>
					{quoteOpen ? "Masquer le message cité" : "··· Afficher le message cité"}
				</button>
			)}
			<div hidden={nouvelle && !quoteOpen}>
			<div className="text-xs text-neutral-500 mb-1">{computed.attribution}</div>
			<div
				ref={(el) => {
					// Montage de la div : contenu initial (HTML modifie d'un brouillon, sinon calcule).
					if (el && el !== initRef.current) {
						initRef.current = el;
						el.innerHTML =
							mode === "custom" && customHtml
								? DOMPurify.sanitize(customHtml)
								: computed.body;
					}
					elRef.current = el;
				}}
				contentEditable
				suppressContentEditableWarning
				onInput={(e) => onChange("custom", DOMPurify.sanitize(e.currentTarget.innerHTML))}
				className="rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 bg-white text-neutral-800 [color-scheme:light] p-2 text-sm max-h-96 overflow-auto outline-none focus:border-neutral-500 [&_img]:max-w-full"
			/>
			</div>
		</div>
	);
}
