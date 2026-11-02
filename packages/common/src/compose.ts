// ss2i : assemblage du corps d'un message sortant (reponse, transfert, nouveau), partage
// par le worker (send-mail.ts, qui envoie), l'editeur web (apercu de la citation) et le
// MCP. Fonctions pures, sans dependance : ce fichier est importe cote navigateur.
//
// Deux reglages interviennent :
// - `quoteScope` : « last » ne cite que le corps propre du message d'origine (son propre
//   historique cite est coupe) ; « thread » cite le message entier (comportement
//   d'origine). Absent = « thread ».
// - `rfcStyle` (option par utilisateur, workspaces.meta.ss2iRfcStyle) : reponse sous la
//   citation, signature tout en bas precedee de la ligne « -- » (RFC 3676 §4.3). Absent =
//   reponse au-dessus, signature entre le texte et la citation (comportement d'origine).

export type ComposeMode = "new" | "reply" | "forward";
export type QuoteScope = "last" | "thread";
// Citation d'une reponse : « auto » (calculee), « custom » (corps cite modifie par
// l'utilisateur dans l'editeur) ou « none » (aucune citation).
export type QuoteMode = "auto" | "custom" | "none";
export type QuoteOverride = { mode: "custom"; html: string } | { mode: "none" } | null;

export type ComposeOriginal = {
	html?: string | null;
	text?: string | null;
	textAsHtml?: string | null;
	subject?: string | null;
	fromName?: string | null;
	fromAddress?: string | null;
	// Date deja mise en forme (« 02 Nov 2026, 10:15 »).
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
	// Reponse seulement : corps cite modifie par l'utilisateur, ou citation supprimee.
	quoteOverride?: QuoteOverride;
};

export const quoteScopeOf = (value: unknown): QuoteScope =>
	value === "last" ? "last" : "thread";

export const quoteModeOf = (value: unknown): QuoteMode =>
	value === "custom" || value === "none" ? value : "auto";

// Override de citation a partir des champs du formulaire / du brouillon (quoteMode,
// quoteHtml). « custom » sans HTML retombe sur « auto ».
export function quoteOverrideOf(mode: unknown, html: unknown): QuoteOverride {
	const m = quoteModeOf(mode);
	if (m === "none") return { mode: "none" };
	if (m === "custom" && typeof html === "string" && html.trim()) return { mode: "custom", html };
	return null;
}

export const DEFAULT_MAIL_TIMEZONE = "Europe/Paris";

// Date de la ligne d'attribution (« 02 Nov 2026, 09:15 »), dans le fuseau des
// utilisateurs (MAIL_TIMEZONE), jamais celui du conteneur. Meme fonction pour le
// worker et l'apercu de l'editeur.
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

// --- HTML, outils minimaux ----------------------------------------------------------

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

// Texte brut approximatif d'un HTML : blocs sur leurs lignes, entites usuelles decodees.
// Meme traitement que la signature (texte derive du HTML de l'identite).
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
		// La ligne « -- » garde son espace final (separateur de signature, RFC 3676).
		.map((l) => (l === "-- " ? l : l.replace(/[ \t]+$/, "")))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const hasVisibleContent = (html: string) =>
	htmlToPlain(html) !== "" || /<img\b/i.test(html);

// HTML « simple » : un texte mis en paragraphes (p, br, div, liens), comme textAsHtml
// de mailparser ou le HTML derive du texte par le MCP. Rien n'y est perdu si la
// citation est reconstruite depuis le texte nettoye.
export function isPlainHtml(html: string): boolean {
	const rest = blankComments(html)
		.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
		.replace(/<\/?(?:html|head|body|meta|title|p|br|div|span|a|pre)\b[^>]*>/gi, "");
	return !/<[a-zA-Z]/.test(rest);
}

// Texte brut -> paragraphes HTML echappes (meme forme que le MCP, bodyParts).
export function textToHtml(text: string): string {
	return text
		.replace(/\r/g, "")
		.split(/\n{2,}/)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

// Les commentaires (conditionnels Outlook compris) ne doivent pas servir de reperes :
// remplaces par des blancs de meme longueur pour garder les positions.
const blankComments = (html: string) =>
	html.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));

// Ferme les balises restees ouvertes apres une coupe (la coupe tombe toujours au debut
// d'une balise, jamais au milieu).
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

// --- Historique cite d'un message ---------------------------------------------------

// Attributs des blocs de citation des clients courants (Gmail, Outlook web, Apple,
// Thunderbird, Yahoo, Proton). Le lecteur (email-viewer.tsx) masque les memes blocs.
const QUOTE_TAG_ATTRS =
	/\b(?:id=["']?(?:divRplyFwdMsg|appendonsend)\b|name=["']?messageReplySection\b|class=["'][^"']*\b(?:gmail_quote|gmail_quote_container|moz-cite-prefix|yahoo_quoted|protonmail_quote)\b)/i;

// Bloc d'en-tetes Outlook (« De : ... Envoye : ... » / « From: ... Sent: ... »).
const OUTLOOK_FROM =
	/<b\b[^>]*>(?:\s*<span\b[^>]*>)*\s*(?:From|De|Von|Da)\s*(?:&nbsp;|&#160;|\u00a0|\s)*:/i;
const OUTLOOK_SENT =
	/(?:Sent|Envoy(?:é|&eacute;|&#233;|&#xe9;)|Gesendet|Date|Inviato)\s*(?:&nbsp;|&#160;|\u00a0|\s)*:/i;

const ORIGINAL_MESSAGE =
	/-{2,}\s*(?:Original Message|Message d(?:'|&#39;|&rsquo;|’)origine)\s*-{2,}/i;

// Ligne d'attribution (« On ..., X wrote: », « Le ..., X a ecrit : ») laissee en fin du
// texte garde, juste avant la citation coupee.
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

// Position du debut de l'historique cite, ou null.
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

	// Texte mis en HTML (textAsHtml, HTML derive du texte) : une ligne « > » devenue
	// « &gt; » en debut de paragraphe ou apres un saut de ligne.
	const gt = src.search(/(?:<(?:p|div)\b[^>]*>|<br\s*\/?>)\s*&gt;/i);
	if (gt >= 0) candidates.push(gt);

	if (!candidates.length) return null;
	return Math.min(...candidates);
}

// Corps propre d'un HTML : l'historique cite est coupe. Si rien de visible ne reste
// (transfert Gmail range tout dans .gmail_quote), le HTML est rendu tel quel.
export function stripQuotedHtml(html: string): { html: string; stripped: boolean } {
	const cut = findQuoteStart(html);
	if (cut == null) return { html, stripped: false };
	let kept = html.slice(0, cut).replace(/(\s|<br\s*\/?>)+$/gi, "");
	const attr = kept.search(TRAILING_ATTRIBUTION);
	if (attr >= 0) {
		kept = kept.slice(0, attr);
		// La balise ouvrante qui portait la ligne d'attribution part avec elle.
		kept = kept
			.replace(/(?:<(?:div|p|span)\b[^>]*>\s*)+$/i, "")
			.replace(/(\s|<br\s*\/?>)+$/gi, "");
	}
	// Blocs vides laisses en queue par la coupe (<p> ouvert sur rien, <div><br></div>).
	kept = kept
		.replace(/(?:<(?:p|div)\b[^>]*>(?:\s|<br\s*\/?>|&nbsp;)*)+$/gi, "")
		.replace(/(?:<(p|div)\b[^>]*>(?:\s|<br\s*\/?>|&nbsp;)*<\/\1>\s*)+$/gi, "");
	kept = closeOpenTags(kept.replace(/\s+$/, ""));
	if (!hasVisibleContent(kept)) return { html, stripped: false };
	return { html: kept, stripped: true };
}

// Lignes qui ouvrent l'historique cite d'un texte brut.
const QUOTE_LINE_MARKERS = [
	/^On .{3,200} wrote:\s*$/i,
	/^Le .{3,200} a (e|é)crit\s*:\s*$/i,
	/^-{2,}\s*(Original|Forwarded) Message\s*-{2,}\s*$/i,
	/^-{2,}\s*Message d['’]origine\s*-{2,}\s*$/i,
	/^_{10,}\s*$/,
	/^De\s*:\s.+$/i,
	/^From:\s.+$/i,
];

// Coupe les citations usuelles (« Le ... a ecrit : », « On ... wrote: », lignes « > »,
// separateur « -----Original Message----- ») pour ne garder que la partie nouvelle.
// Si rien ne reste, le texte est rendu tel quel.
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

// --- Signature delimitee « -- » (RFC 3676) ------------------------------------------

// Retire la signature d'un texte brut quand elle est delimitee par la ligne « -- »
// (tiret, tiret, espace). Aucune heuristique sur les signatures non delimitees. Avec
// keepQuoteAfter (portee « thread »), un historique cite qui suit la signature (lignes
// « > », ligne d'attribution) est garde : seule la signature part.
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

// Meme chose en HTML : bloc signature de courrier (class="signature" ouvert par la ligne
// « -- ») ou de Thunderbird (moz-signature), ou une ligne « -- » seule en debut de
// paragraphe ou apres un saut de ligne (texte mis en HTML) ; seulement si rien d'autre
// qu'une signature ne suit (aucune citation apres).
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
	// Derniere ligne « -- » (exactement, suivie d'un saut de ligne ou de la fin du bloc).
	const lineRe = /(?:<(?:p|div|pre)\b[^>]*>|<br\s*\/?>)\s*--(?: |&nbsp;|&#160;|\u00a0)(?:\s*<br\s*\/?>|\n|\s*<\/(?:p|div|pre)>)/gi;
	let last: RegExpExecArray | null = null;
	while ((m = lineRe.exec(src))) last = m;
	// Un historique qui suit la ligne « -- » : en portee « thread » le HTML est laisse (le
	// texte, lui, est nettoye ; un HTML simple est alors reconstruit depuis le texte).
	const quoteFollows = (rest: string) =>
		/<blockquote\b/i.test(rest) || (opts.keepQuoteAfter && findQuoteStart(rest) != null);
	if (last && !quoteFollows(src.slice(last.index))) {
		const kept = closeOpenTags(html.slice(0, last.index).replace(/\s+$/, ""));
		return hasVisibleContent(kept) ? kept : html;
	}
	return html;
}

// --- Citation -------------------------------------------------------------------------

// Prefixe « > » (ou « > » colle a un niveau existant : « >> »).
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

// Corps du message d'origine tel qu'il sera cite, selon la portee et le style.
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
		// Message en texte seul : le texte coupe fait foi, pas textAsHtml (qui cite tout).
		if (!html && text) fallbackHtml = `<pre style="white-space:pre-wrap;margin:0;">${escapeHtml(text)}</pre>`;
	}
	if (rfc) {
		if (!text && html) text = htmlToPlain(html);
		text = stripSignatureText(text, { keepQuoteAfter: scope === "thread" });
		if (html) html = stripSignatureHtml(html, { keepQuoteAfter: scope === "thread" });
	}
	// Quand le nettoyage (portee « last », style RFC) a change le texte et que le HTML
	// n'est qu'un texte mis en paragraphes, le HTML cite est reconstruit depuis le texte
	// nettoye : texte et HTML disent alors la meme chose. Sinon, rien ne change.
	if (givenText && text.trim() !== givenText && isPlainHtml(orig.html || "")) {
		html = textToHtml(text);
	}
	return { html, text, fallbackHtml };
}

// Citation complete (ligne d'attribution + corps), en texte et en HTML. `customHtml` :
// corps deja pret (modifie par l'utilisateur) qui remplace le corps calcule ; le texte
// en est derive, l'attribution et l'enveloppe restent les memes.
export function buildQuote(
	orig: ComposeOriginal,
	opts: { quoteScope?: QuoteScope | null; rfcStyle?: boolean; customHtml?: string | null },
) {
	const q =
		opts.customHtml != null
			? { html: opts.customHtml, text: htmlToPlain(opts.customHtml), fallbackHtml: "" }
			: quotedOriginal(orig, opts);
	const attribution = attributionText(orig);
	// Corps cite seul (ce que l'editeur propose a la modification).
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

// Signature de l'identite : le HTML est repris tel quel (tableaux, styles en ligne) ; le
// texte brut en est une version depouillee de ses balises, toujours derriere « -- ».
// En style RFC, le HTML porte aussi la ligne « -- » (white-space:pre garde l'espace
// final a l'affichage et a la copie).
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

// --- Assemblage -----------------------------------------------------------------------

export function composeMessage(input: ComposeInput) {
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

	// Citation modifiee ou supprimee : reponse seulement, un transfert l'ignore.
	const override = isReply ? (input.quoteOverride ?? null) : null;
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
		// Citation, puis la reponse, puis « -- » et la signature ; un transfert garde
		// son texte en tete et le message transfere dessous, la signature tout en bas.
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

	// Comportement d'origine : reponse, signature, puis la citation.
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
