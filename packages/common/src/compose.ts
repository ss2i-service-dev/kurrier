import { joinSurrogateEntities } from "./html-entities";
// Assembly of the body of an outgoing message (reply, forward, new), shared by the
// worker (send-mail.ts, which sends), the web editor (quote preview) and the MCP.
// Pure functions, no dependency: this file is imported on the browser side.
//
// Two settings apply:
// - `quoteScope`: "last" only quotes the own body of the original message (its own quoted
//   history is cut); "thread" quotes the whole message (default behaviour). Absent = "thread".
// - `rfcStyle` (per-user option, workspaces.meta.prefRfcStyle): reply below the quote,
//   signature at the very bottom preceded by the "-- " line (RFC 3676 section 4.3).
//   Absent = reply above, signature between the text and the quote (default behaviour).

export type ComposeMode = "new" | "reply" | "forward";
export type QuoteScope = "last" | "thread";
// Quote of a reply: "auto" (computed), "custom" (quoted body edited by the user in the
// editor) or "none" (no quote).
export type QuoteMode = "auto" | "custom" | "none";
export type QuoteOverride = { mode: "custom"; html: string } | { mode: "none" } | null;

export type ComposeOriginal = {
	html?: string | null;
	text?: string | null;
	textAsHtml?: string | null;
	subject?: string | null;
	fromName?: string | null;
	fromAddress?: string | null;
	// Already formatted date ("02 Nov 2026, 10:15").
	dateLabel?: string | null;
};

export type ComposeInput = {
	mode: ComposeMode;
	subject?: string | null;
	text?: string | null;
	html?: string | null;
	signatureHtml?: string | null;
	orig?: ComposeOriginal | null;
	rfcStyle?: boolean;
	quoteScope?: QuoteScope | null;
	// Quoted body edited by the user (reply or forward), or quote removed (reply only).
	quoteOverride?: QuoteOverride;
};

export const quoteScopeOf = (value: unknown): QuoteScope =>
	value === "last" ? "last" : "thread";

export const quoteModeOf = (value: unknown): QuoteMode =>
	value === "custom" || value === "none" ? value : "auto";

// Quote override from the form / draft fields (quoteMode, quoteHtml). "custom" without
// HTML falls back to "auto".
export function quoteOverrideOf(mode: unknown, html: unknown): QuoteOverride {
	const m = quoteModeOf(mode);
	if (m === "none") return { mode: "none" };
	if (m === "custom" && typeof html === "string" && html.trim()) return { mode: "custom", html };
	return null;
}

export const DEFAULT_MAIL_TIMEZONE = "UTC";

// Date of the attribution line ("02 Nov 2026, 09:15"), in the users' time zone
// (MAIL_TIMEZONE), never the container's. Same function for the worker and the editor
// preview.
export function formatQuoteDate(
	date: Date | string | number | null | undefined,
	timeZone?: string | null,
): string {
	if (!date) return "";
	const d = new Date(date);
	if (Number.isNaN(d.getTime())) return "";
	const opts: Intl.DateTimeFormatOptions = {
		year: "numeric",
		month: "short",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	};
	try {
		return d.toLocaleString("en-GB", { ...opts, timeZone: timeZone || DEFAULT_MAIL_TIMEZONE });
	} catch {
		return d.toLocaleString("en-GB", { ...opts, timeZone: DEFAULT_MAIL_TIMEZONE });
	}
}

// --- HTML, minimal tools ------------------------------------------------------------

const VOID_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);

export const escapeHtml = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

// Approximate plain text of an HTML: blocks on their own lines, common entities decoded.
// Same treatment as the signature (text derived from the identity's HTML).
export function htmlToPlain(html: string): string {
	return html
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|pre)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;|&#160;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/\r/g, "")
		.split("\n")
		// The "-- " line keeps its trailing space (signature separator, RFC 3676).
		.map((l) => (l === "-- " ? l : l.replace(/[ \t]+$/, "")))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const hasVisibleContent = (html: string) =>
	htmlToPlain(html) !== "" || /<img\b/i.test(html);

// "Simple" HTML: a text laid out in paragraphs (p, br, div, links), like mailparser's
// textAsHtml or the HTML derived from text by the MCP. Nothing is lost if the quote is
// rebuilt from the cleaned text.
export function isPlainHtml(html: string): boolean {
	const rest = blankComments(html)
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<\/?(?:html|head|body|meta|title|p|br|div|span|a|pre)\b[^>]*>/gi, "");
	return !/<[a-zA-Z]/.test(rest);
}

// Plain text -> escaped HTML paragraphs (same form as the MCP, bodyParts).
export function textToHtml(text: string): string {
	return text
		.replace(/\r/g, "")
		.split(/\n{2,}/)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

// Comments (Outlook conditionals included) must not be used as landmarks: replaced by
// blanks of the same length to keep the positions.
const blankComments = (html: string) =>
	html.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));

// Closes the tags left open after a cut (the cut always falls at the start of a tag,
// never in the middle of one).
export function closeOpenTags(html: string): string {
	const src = blankComments(html).replace(
		/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,
		(m) => " ".repeat(m.length),
	);
	const stack: string[] = [];
	const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		const name = m[2].toLowerCase();
		if (m[1]) {
			const i = stack.lastIndexOf(name);
			if (i >= 0) stack.splice(i);
		} else if (!VOID_TAGS.has(name) && !m[0].endsWith("/>")) {
			stack.push(name);
		}
	}
	return html + stack.reverse().map((n) => `</${n}>`).join("");
}

// --- Quoted history of a message ----------------------------------------------------

// Attributes of the quote blocks of common clients (Gmail, Outlook web, Apple,
// Thunderbird, Yahoo, Proton). The viewer (email-viewer.tsx) hides the same blocks.
const QUOTE_TAG_ATTRS =
	/\b(?:id=["']?(?:divRplyFwdMsg|appendonsend)\b|name=["']?messageReplySection\b|class=["'][^"']*\b(?:gmail_quote|gmail_quote_container|moz-cite-prefix|yahoo_quoted|protonmail_quote)\b)/i;

// Outlook header block ("From: ... Sent: ..." and its localized forms).
const OUTLOOK_FROM =
	/<b\b[^>]*>(?:\s*<span\b[^>]*>)*\s*(?:From|De|Von|Da)\s*(?:&nbsp;|&#160;|\u00a0|\s)*:/i;
const OUTLOOK_SENT =
	/(?:Sent|Envoy(?:é|&eacute;|&#233;|&#xe9;)|Gesendet|Date|Inviato)\s*(?:&nbsp;|&#160;|\u00a0|\s)*:/i;

const ORIGINAL_MESSAGE =
	/-{2,}\s*(?:Original Message|Message d(?:'|&#39;|&rsquo;|’)origine)\s*-{2,}/i;

// Attribution line ("On ..., X wrote:" and its French form "Le ..., X a ecrit :") left at
// the end of the kept text, just before the cut quote.
const TRAILING_ATTRIBUTION =
	/(?:On|Le)\s(?:[^<]|<a\b[^>]*>|<\/a>|<span\b[^>]*>|<\/span>|<b>|<\/b>){3,300}?\b(?:wrote|a (?:é|&eacute;|&#233;|e)crit)\s*:?\s*(?:<\/[a-z]+>|<br\s*\/?>|&nbsp;|\s)*$/i;

const lastIndexOfRe = (s: string, re: RegExp, from: number, window: number) => {
	const start = Math.max(0, from - window);
	const slice = s.slice(start, from);
	const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
	let last = -1;
	let m: RegExpExecArray | null;
	while ((m = g.exec(slice))) last = m.index;
	return last < 0 ? -1 : start + last;
};

// Position of the start of the quoted history, or null.
export function findQuoteStart(html: string): number | null {
	const src = blankComments(html);
	const candidates: number[] = [];

	const bq = src.search(/<blockquote\b/i);
	if (bq >= 0) candidates.push(bq);

	const tagRe = /<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/g;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(src))) {
		if (QUOTE_TAG_ATTRS.test(m[0])) {
			candidates.push(m.index);
			break;
		}
	}

	const from = src.search(OUTLOOK_FROM);
	if (from >= 0 && OUTLOOK_SENT.test(src.slice(from, from + 1500))) {
		const hr = lastIndexOfRe(src, /<hr\b/i, from, 600);
		const bordered = lastIndexOfRe(src, /<div\b[^>]*border-top/i, from, 800);
		const block = lastIndexOfRe(src, /<(?:p|div)\b/i, from, 400);
		candidates.push(hr >= 0 ? hr : bordered >= 0 ? bordered : block >= 0 ? block : from);
	}

	const om = src.search(ORIGINAL_MESSAGE);
	if (om >= 0) {
		const lt = src.lastIndexOf("<", om);
		candidates.push(lt >= 0 && om - lt < 200 ? lt : om);
	}

	// Text turned into HTML (textAsHtml, HTML derived from text): a ">" line that became
	// "&gt;" at the start of a paragraph or after a line break.
	const gt = src.search(/(?:<(?:p|div)\b[^>]*>|<br\s*\/?>)\s*&gt;/i);
	if (gt >= 0) candidates.push(gt);

	if (!candidates.length) return null;
	return Math.min(...candidates);
}

// Own body of an HTML: the quoted history is cut. If nothing visible remains (a Gmail
// forward puts everything in .gmail_quote), the HTML is returned as is.
export function stripQuotedHtml(html: string): { html: string; stripped: boolean } {
	const cut = findQuoteStart(html);
	if (cut == null) return { html, stripped: false };
	let kept = html.slice(0, cut).replace(/(\s|<br\s*\/?>)+$/gi, "");
	const attr = kept.search(TRAILING_ATTRIBUTION);
	if (attr >= 0) {
		kept = kept.slice(0, attr);
		// The opening tag that carried the attribution line goes with it.
		kept = kept
			.replace(/(?:<(?:div|p|span)\b[^>]*>\s*)+$/i, "")
			.replace(/(\s|<br\s*\/?>)+$/gi, "");
	}
	// Empty blocks left at the tail by the cut (<p> opened on nothing, <div><br></div>).
	kept = kept
		.replace(/(?:<(?:p|div)\b[^>]*>(?:\s|<br\s*\/?>|&nbsp;)*)+$/gi, "")
		.replace(/(?:<(p|div)\b[^>]*>(?:\s|<br\s*\/?>|&nbsp;)*<\/\1>\s*)+$/gi, "");
	kept = closeOpenTags(kept.replace(/\s+$/, ""));
	if (!hasVisibleContent(kept)) return { html, stripped: false };
	return { html: kept, stripped: true };
}

// Lines that open the quoted history of a plain text.
const QUOTE_LINE_MARKERS = [
	/^On .{3,200} wrote:\s*$/i,
	/^Le .{3,200} a (e|é)crit\s*:\s*$/i,
	/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}\s*$/i,
	/^-{2,}\s*Message d['’]origine\s*-{2,}\s*$/i,
	/^_{10,}\s*$/,
	/^De\s*:\s.+$/i,
	/^From:\s.+$/i,
];

// Cuts the usual quotes ("On ... wrote:" and localized forms, ">" lines,
// "-----Original Message-----" separator) to keep only the new part.
// If nothing remains, the text is returned as is.
export function stripQuotedText(text: string): string {
	const lines = text.replace(/\r/g, "").split("\n");
	let cut = lines.length;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i].trim();
		if (l.startsWith(">") || QUOTE_LINE_MARKERS.some((re) => re.test(l))) {
			cut = i;
			break;
		}
	}
	const kept = lines.slice(0, cut).join("\n").trim();
	return kept || text;
}

// --- Signature delimited by "-- " (RFC 3676) ----------------------------------------

// Removes the signature of a plain text when it is delimited by the "-- " line
// (dash, dash, space). No heuristic for undelimited signatures. With keepQuoteAfter
// ("thread" scope), a quoted history that follows the signature (">" lines, attribution
// line) is kept: only the signature goes.
export function stripSignatureText(text: string, opts: { keepQuoteAfter?: boolean } = {}): string {
	const lines = text.replace(/\r/g, "").split("\n");
	let cut = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i] === "-- ") {
			cut = i;
			break;
		}
	}
	if (cut < 0) return text;
	let resume = lines.length;
	if (opts.keepQuoteAfter) {
		for (let i = cut + 1; i < lines.length; i++) {
			const l = lines[i].trim();
			if (l.startsWith(">") || QUOTE_LINE_MARKERS.some((re) => re.test(l))) {
				resume = i;
				break;
			}
		}
	}
	const before = lines.slice(0, cut).join("\n").replace(/\s+$/, "");
	const after = resume < lines.length ? lines.slice(resume).join("\n") : "";
	const kept = after ? `${before}\n\n${after}` : before;
	return kept.trim() ? kept : text;
}

// Same in HTML: mail signature block (class="signature" opened by the "-- " line) or
// Thunderbird's (moz-signature), or a lone "-- " line at the start of a paragraph or
// after a line break (text turned into HTML); only if nothing but a signature follows
// (no quote after).
export function stripSignatureHtml(html: string, opts: { keepQuoteAfter?: boolean } = {}): string {
	const src = blankComments(html);
	const re = /<(?:div|pre|p)\b[^>]*class=["'][^"']*\b(?:signature|moz-signature)\b[^"']*["'][^>]*>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src))) {
		const rest = src.slice(m.index);
		const delimited = /moz-signature/i.test(m[0]) || /^[\s\S]{0,300}?--(?: |&nbsp;|&#160;|\u00a0)/.test(rest);
		if (!delimited || /<blockquote\b/i.test(rest)) continue;
		const kept = closeOpenTags(html.slice(0, m.index).replace(/\s+$/, ""));
		return hasVisibleContent(kept) ? kept : html;
	}
	// Last "-- " line (exactly, followed by a line break or the end of the block).
	const lineRe = /(?:<(?:p|div|pre)\b[^>]*>|<br\s*\/?>)\s*--(?: |&nbsp;|&#160;|\u00a0)(?:\s*<br\s*\/?>|\n|\s*<\/(?:p|div|pre)>)/gi;
	let last: RegExpExecArray | null = null;
	while ((m = lineRe.exec(src))) last = m;
	// A history that follows the "-- " line: in "thread" scope the HTML is left alone (the
	// text is cleaned; a simple HTML is then rebuilt from the text).
	const quoteFollows = (rest: string) =>
		/<blockquote\b/i.test(rest) || (opts.keepQuoteAfter && findQuoteStart(rest) != null);
	if (last && !quoteFollows(src.slice(last.index))) {
		const kept = closeOpenTags(html.slice(0, last.index).replace(/\s+$/, ""));
		return hasVisibleContent(kept) ? kept : html;
	}
	return html;
}

// --- Quote ----------------------------------------------------------------------------

// ">" prefix (or ">" glued to an existing level: ">>").
export function quoteTextLines(text: string): string {
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map((l) => (l === "" ? ">" : l.startsWith(">") ? `>${l}` : `> ${l}`))
		.join("\n");
}

const QUOTE_STYLE = "border-left:2px solid #ccc;margin:0;padding-left:8px;";

const attributionText = (orig: ComposeOriginal) =>
	`On ${orig.dateLabel ?? ""}, ${orig.fromName ?? ""} <${orig.fromAddress ?? ""}> wrote:`;

// Body of the original message as it will be quoted, depending on scope and style.
export function quotedOriginal(
	orig: ComposeOriginal,
	opts: { quoteScope?: QuoteScope | null; rfcStyle?: boolean },
) {
	const scope = quoteScopeOf(opts.quoteScope);
	const rfc = Boolean(opts.rfcStyle);
	let html = orig.html || "";
	let text = orig.text || "";
	let fallbackHtml = orig.textAsHtml || "";
	const givenText = (orig.text || "").trim();

	if (scope === "last") {
		if (text) text = stripQuotedText(text);
		if (html) html = stripQuotedHtml(html).html;
		// Plain-text message: the cut text is authoritative, not textAsHtml (which quotes everything).
		if (!html && text) fallbackHtml = `<pre style="white-space:pre-wrap;margin:0;">${escapeHtml(text)}</pre>`;
	}
	if (rfc) {
		if (!text && html) text = htmlToPlain(html);
		text = stripSignatureText(text, { keepQuoteAfter: scope === "thread" });
		if (html) html = stripSignatureHtml(html, { keepQuoteAfter: scope === "thread" });
	}
	// When cleaning (the "last" scope, RFC style) changed the text and the HTML is only a text
	// laid out in paragraphs, the quoted HTML is rebuilt from the cleaned text: text and HTML
	// then say the same thing. Otherwise, nothing changes.
	if (givenText && text.trim() !== givenText && isPlainHtml(orig.html || "")) {
		html = textToHtml(text);
	}
	return { html, text, fallbackHtml };
}

// Full quote (attribution line + body), in text and HTML. `customHtml`: ready-made body
// (edited by the user) that replaces the computed body; the text is derived from it, the
// attribution and the wrapper stay the same.
export function buildQuote(
	orig: ComposeOriginal,
	opts: { quoteScope?: QuoteScope | null; rfcStyle?: boolean; customHtml?: string | null },
) {
	// Outlook emojis as pairs of surrogate references, otherwise quoted as "��".
	if (orig.html) orig = { ...orig, html: joinSurrogateEntities(orig.html) };
	const q =
		opts.customHtml != null
			? { html: opts.customHtml, text: htmlToPlain(opts.customHtml), fallbackHtml: "" }
			: quotedOriginal(orig, opts);
	const attribution = attributionText(orig);
	// Quoted body alone (what the editor offers for editing).
	const body = q.html || q.fallbackHtml || `<pre style="white-space:pre-wrap;margin:0;">${escapeHtml(q.text)}</pre>`;
	if (opts.rfcStyle) {
		return {
			attribution,
			body,
			text: `${attribution}\n${quoteTextLines(q.text)}`,
			html: `<div class="quote-attribution">${escapeHtml(attribution)}</div>
<blockquote type="cite" style="${QUOTE_STYLE}">
  ${body}
</blockquote>`,
		};
	}
	return {
		attribution,
		body,
		text: `${attribution}\n${q.text}`,
		html: `<hr>
<p>On ${orig.dateLabel ?? ""}, ${orig.fromName ?? ""} &lt;${orig.fromAddress ?? ""}&gt; wrote:</p>
<blockquote style="${QUOTE_STYLE}">
  ${q.html || q.fallbackHtml || `<pre style="white-space:pre-wrap;margin:0;">${q.text}</pre>`}
</blockquote>`,
	};
}

// --- Signature ------------------------------------------------------------------------

// Identity signature: the HTML is kept as is (tables, inline styles); the plain text is a
// version stripped of its tags, always behind "-- ". In RFC style, the HTML also carries
// the "-- " line (white-space:pre keeps the trailing space on display and on copy).
export function signatureBlocks(signatureHtml?: string | null, rfcStyle = false) {
	const sig = (signatureHtml ?? "").trim();
	if (!sig) return { html: "", text: "" };
	const text = sig
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	const separator = rfcStyle ? `<div style="white-space:pre">-- </div>` : "";
	return {
		html: `<div class="signature" style="margin-top:1em">${separator}${sig}</div>`,
		text: `\n\n-- \n${text}`,
	};
}

// --- Assembly -------------------------------------------------------------------------

// An empty paragraph (<p></p>, a line left empty in the editor) has zero height in mail
// clients: it goes out as <p><br></p> so that the empty line is kept.
export function keepEmptyLines(html: string): string {
	return html.replace(/<p(\s[^>]*)?><\/p>/g, (_m, attrs = "") => `<p${attrs}><br></p>`);
}

export function composeMessage(rawInput: ComposeInput) {
	const input: ComposeInput = {
		...rawInput,
		html: rawInput.html == null ? rawInput.html : keepEmptyLines(rawInput.html),
		quoteOverride:
			rawInput.quoteOverride?.mode === "custom" && rawInput.quoteOverride.html
				? { ...rawInput.quoteOverride, html: keepEmptyLines(rawInput.quoteOverride.html) }
				: rawInput.quoteOverride,
	};
	const rfc = Boolean(input.rfcStyle);
	const signature = signatureBlocks(input.signatureHtml, rfc);
	const orig = input.orig ?? null;
	if (!orig) {
		return {
			subject: input.subject ?? "(no subject)",
			text: `${input.text ?? ""}${signature.text}`,
			html: `${input.html ?? ""}${signature.html}`,
		};
	}
	const isReply = input.mode === "reply";
	const isForward = input.mode === "forward";

	const baseSubj = (input.subject ?? "").trim();
	let subject = baseSubj;
	if (isReply) {
		const s = (orig.subject ?? "").trim();
		subject = s.startsWith("Re:") ? s : `Re: ${s || "(no subject)"}`;
	} else if (isForward) {
		const s = (orig.subject ?? "").trim();
		subject = s.startsWith("Fwd:") ? s : `Fwd: ${s || "(no subject)"}`;
	} else if (!baseSubj) {
		subject = "(no subject)";
	}

	// Edited quote (reply and forward) or removed (reply only: a forward always keeps the
	// forwarded message).
	const rawOverride = isReply || isForward ? (input.quoteOverride ?? null) : null;
	const override = isForward && rawOverride?.mode === "none" ? null : rawOverride;
	const noQuote = override?.mode === "none";
	const quote = noQuote
		? { attribution: "", text: "", html: "" }
		: buildQuote(orig, {
				quoteScope: input.quoteScope,
				rfcStyle: rfc,
				customHtml: override?.mode === "custom" ? override.html : null,
			});
	const userText = input.text ?? "";
	const userHtml = input.html ?? "";

	if (rfc) {
		// Quote, then the reply, then "-- " and the signature; a forward keeps its text first and
		// the forwarded message below, the signature at the very bottom.
		const text = isReply
			? noQuote
				? `${userText}${signature.text}`
				: `${quote.text}\n\n${userText}${signature.text}`
			: isForward
				? `${userText}\n\nForwarded message:\n${quote.text}${signature.text}`
				: `${userText}${signature.text}`;
		const html = isReply
			? noQuote
				? `${userHtml}${signature.html}`
				: `${quote.html}\n${userHtml}${signature.html}`
			: isForward
				? `${userHtml}<p>Forwarded message:</p>${quote.html}${signature.html}`
				: `${userHtml}${signature.html}`;
		return { subject, text, html };
	}

	// Default behaviour: reply, signature, then the quote.
	const bodyText = `${userText}${signature.text}`;
	const bodyHtml = `${userHtml}${signature.html}`;
	const text = isReply
		? noQuote
			? bodyText
			: `${bodyText}\n\n${quote.text}`
		: isForward
			? `${bodyText}\n\nForwarded message:\n${quote.text}`
			: bodyText;
	const html = isReply
		? noQuote
			? bodyHtml
			: `${bodyHtml}${quote.html}`
		: isForward
			? `${bodyHtml}<p>Forwarded message:</p>${quote.html}`
			: bodyHtml;
	return { subject, text, html };
}
