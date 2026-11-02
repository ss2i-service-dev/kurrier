// Assemblage du corps des messages sortants (packages/common/src/compose.ts) : style
// d'origine inchange (non-regression), style RFC (citation, reponse, « -- » + signature),
// portee de la citation (dernier message seulement / tout le fil) et coupe des
// historiques Gmail, Outlook, Apple et texte. Aucune base, aucun Redis. Lancement
// (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/compose-body.ts
import assert from "node:assert/strict";
import {
	closeOpenTags,
	composeMessage,
	quoteTextLines,
	stripQuotedHtml,
	stripQuotedText,
	stripSignatureHtml,
	stripSignatureText,
	type ComposeOriginal,
} from "../../../packages/common/src/compose";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err).split("\n").join("\n      ")}`);
	}
};

const SIG = `<table><tr><td>Samuel LEGROS<br>SS2i Services</td></tr></table>`;
const SIG_TEXT = "Samuel LEGROS\nSS2i Services";

const orig: ComposeOriginal = {
	subject: "Devis serveur",
	fromName: "Jean Client",
	fromAddress: "jean@client.example",
	dateLabel: "02 Nov 2026, 09:15",
	text: "Bonjour,\n\nPouvez-vous chiffrer ?\n\nJean",
	html: "<div>Bonjour,</div><div><br></div><div>Pouvez-vous chiffrer ?</div><div><br></div><div>Jean</div>",
};

// --- Style d'origine : sortie identique a l'ancien generateMailAttrs ----------------------

test("origine, reply : reponse, signature, puis citation (texte et HTML exacts)", () => {
	const r = composeMessage({
		mode: "reply",
		text: "Oui, demain.",
		html: "<p>Oui, demain.</p>",
		signatureHtml: SIG,
		orig,
	});
	assert.equal(r.subject, "Re: Devis serveur");
	assert.equal(
		r.text,
		`Oui, demain.\n\n-- \n${SIG_TEXT}\n\nOn 02 Nov 2026, 09:15, Jean Client <jean@client.example> wrote:\n${orig.text}`,
	);
	assert.equal(
		r.html,
		`<p>Oui, demain.</p><div class="signature" style="margin-top:1em">${SIG}</div><hr>
<p>On 02 Nov 2026, 09:15, Jean Client &lt;jean@client.example&gt; wrote:</p>
<blockquote style="border-left:2px solid #ccc;margin:0;padding-left:8px;">
  ${orig.html}
</blockquote>`,
	);
});

test("origine, forward : libelle Forwarded message, Fwd:", () => {
	const r = composeMessage({ mode: "forward", text: "FYI", html: "<p>FYI</p>", signatureHtml: SIG, orig });
	assert.equal(r.subject, "Fwd: Devis serveur");
	assert.equal(
		r.text,
		`FYI\n\n-- \n${SIG_TEXT}\n\nForwarded message:\nOn 02 Nov 2026, 09:15, Jean Client <jean@client.example> wrote:\n${orig.text}`,
	);
	assert.ok(r.html.startsWith(`<p>FYI</p><div class="signature" style="margin-top:1em">${SIG}</div><p>Forwarded message:</p><hr>`));
});

test("origine, new : texte et signature, sans separateur HTML ; sans signature rien n'est ajoute", () => {
	const r = composeMessage({ mode: "new", subject: "Hello", text: "Salut", html: "<p>Salut</p>", signatureHtml: SIG });
	assert.equal(r.subject, "Hello");
	assert.equal(r.text, `Salut\n\n-- \n${SIG_TEXT}`);
	assert.equal(r.html, `<p>Salut</p><div class="signature" style="margin-top:1em">${SIG}</div>`);
	const none = composeMessage({ mode: "new", text: "Salut", html: "<p>Salut</p>", signatureHtml: "" });
	assert.equal(none.subject, "(no subject)");
	assert.equal(none.text, "Salut");
	assert.equal(none.html, "<p>Salut</p>");
});

test("origine, Re:/Fwd: deja presents et sujet vide", () => {
	assert.equal(composeMessage({ mode: "reply", orig: { ...orig, subject: "Re: X" } }).subject, "Re: X");
	assert.equal(composeMessage({ mode: "forward", orig: { ...orig, subject: "" } }).subject, "Fwd: (no subject)");
});

test("origine, portee thread sans HTML : textAsHtml puis <pre> non echappe (inchange)", () => {
	const r = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig: { ...orig, html: null, textAsHtml: "<p>Bonjour</p>" } });
	assert.ok(r.html.includes("<p>Bonjour</p>"));
	const r2 = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig: { ...orig, html: null, text: "a <b> c" } });
	assert.ok(r2.html.includes('<pre style="white-space:pre-wrap;margin:0;">a <b> c</pre>'));
});

// --- Style RFC --------------------------------------------------------------------------

test("RFC, reply : citation prefixee « > », puis la reponse, puis « -- » et la signature", () => {
	const r = composeMessage({
		mode: "reply",
		text: "Oui, demain.",
		html: "<p>Oui, demain.</p>",
		signatureHtml: SIG,
		orig,
		rfcStyle: true,
	});
	assert.equal(
		r.text,
		`On 02 Nov 2026, 09:15, Jean Client <jean@client.example> wrote:\n> Bonjour,\n>\n> Pouvez-vous chiffrer ?\n>\n> Jean\n\nOui, demain.\n\n-- \n${SIG_TEXT}`,
	);
	// La ligne de separation est exactement « -- » suivi d'un espace.
	assert.ok(r.text.includes("\n-- \n"));
	assert.ok(!/\n--\n/.test(r.text));
	assert.ok(r.text.endsWith(SIG_TEXT));
	const iQuote = r.html.indexOf("<blockquote");
	const iBody = r.html.indexOf("<p>Oui, demain.</p>");
	const iSig = r.html.indexOf('<div class="signature"');
	assert.ok(iQuote >= 0 && iQuote < iBody && iBody < iSig, "ordre HTML : citation, reponse, signature");
	assert.ok(r.html.startsWith('<div class="quote-attribution">On 02 Nov 2026, 09:15, Jean Client &lt;jean@client.example&gt; wrote:</div>'));
	assert.ok(r.html.includes('<div class="signature" style="margin-top:1em"><div style="white-space:pre">-- </div>'));
	assert.ok(!r.html.includes("<hr>"));
});

test("RFC, reply sans signature : pas de « -- »", () => {
	const r = composeMessage({ mode: "reply", text: "Oui", html: "<p>Oui</p>", orig, rfcStyle: true });
	assert.ok(!r.text.includes("-- "));
	assert.ok(r.text.endsWith("\n\nOui"));
});

test("RFC, forward : texte, message transfere, puis « -- » et la signature tout en bas", () => {
	const r = composeMessage({ mode: "forward", text: "FYI", html: "<p>FYI</p>", signatureHtml: SIG, orig, rfcStyle: true });
	assert.equal(
		r.text,
		`FYI\n\nForwarded message:\nOn 02 Nov 2026, 09:15, Jean Client <jean@client.example> wrote:\n> Bonjour,\n>\n> Pouvez-vous chiffrer ?\n>\n> Jean\n\n-- \n${SIG_TEXT}`,
	);
	assert.ok(r.html.endsWith(`${SIG}</div>`));
	assert.ok(r.html.indexOf("<p>FYI</p>") < r.html.indexOf("<blockquote"));
});

test("RFC, new : signature HTML avec la ligne « -- »", () => {
	const r = composeMessage({ mode: "new", text: "Salut", html: "<p>Salut</p>", signatureHtml: SIG, rfcStyle: true });
	assert.equal(r.text, `Salut\n\n-- \n${SIG_TEXT}`);
	assert.equal(r.html, `<p>Salut</p><div class="signature" style="margin-top:1em"><div style="white-space:pre">-- </div>${SIG}</div>`);
});

test("RFC : la signature delimitee « -- » de l'original est retiree de la citation", () => {
	const r = composeMessage({
		mode: "reply",
		text: "Vu.",
		html: "<p>Vu.</p>",
		orig: {
			...orig,
			text: "Bonjour,\n\nMerci.\n-- \nJean Client\nTel 05",
			html: `<div>Bonjour,</div><div>Merci.</div><div class="signature" style="margin-top:1em"><div style="white-space:pre">-- </div><b>Jean Client</b></div>`,
		},
		rfcStyle: true,
	});
	assert.ok(r.text.includes("> Bonjour,\n>\n> Merci.\n\nVu."), r.text);
	assert.ok(!r.text.includes("Tel 05"));
	assert.ok(!r.html.includes("Jean Client</b>"));
	assert.ok(r.html.includes("<div>Merci.</div>\n</blockquote>"), r.html);
});

test("RFC : une signature non delimitee reste dans la citation (aucune heuristique)", () => {
	const r = composeMessage({ mode: "reply", text: "Vu.", orig: { ...orig, text: "Merci.\n\nJean Client\nOutlook" }, rfcStyle: true });
	assert.ok(r.text.includes("> Jean Client\n> Outlook"));
});

test("RFC : niveaux de citation existants respectes (>> )", () => {
	assert.equal(quoteTextLines("a\n> b\n>> c\n"), "> a\n>> b\n>>> c\n>");
	const r = composeMessage({ mode: "reply", text: "x", orig: { ...orig, text: "Oui\n> Non" }, rfcStyle: true, quoteScope: "thread" });
	assert.ok(r.text.includes("> Oui\n>> Non"));
});

test("RFC : original HTML sans partie texte -> texte derive du HTML pour la citation", () => {
	const r = composeMessage({ mode: "reply", text: "x", orig: { ...orig, text: null }, rfcStyle: true });
	assert.ok(r.text.includes("> Bonjour,\n>\n> Pouvez-vous chiffrer ?"), r.text);
});

test("stripSignatureText : seule la ligne exacte « -- » delimite", () => {
	assert.equal(stripSignatureText("a\n--\nb"), "a\n--\nb");
	assert.equal(stripSignatureText("a\n-- \nb"), "a");
	assert.equal(stripSignatureText("-- \nb"), "-- \nb");
	assert.equal(stripSignatureHtml(`<p>a</p><pre class="moz-signature" cols="72">-- \nJean</pre>`), "<p>a</p>");
	// Signature de courrier placee avant une citation (style d'origine) : laissee.
	const mid = `<p>a</p><div class="signature"><div style="white-space:pre">-- </div>J</div><blockquote>q</blockquote>`;
	assert.equal(stripSignatureHtml(mid), mid);
});

// --- Portee « dernier message seulement » -----------------------------------------------

const GMAIL = `<div dir="ltr">Merci, c'est note.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Le lun. 2 nov. 2026 à 09:00, Samuel &lt;<a href="mailto:s@x">s@x</a>&gt; a écrit :<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div>Ancien message</div></blockquote></div>`;

test("last, Gmail : seul le corps propre est cite", () => {
	const s = stripQuotedHtml(GMAIL);
	assert.equal(s.stripped, true);
	assert.equal(s.html, `<div dir="ltr">Merci, c'est note.</div>`);
	const r = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig: { ...orig, html: GMAIL, text: "Merci, c'est note.\n\nLe lun. 2 nov. 2026 à 09:00, Samuel <s@x> a écrit :\n> Ancien message" }, quoteScope: "last" });
	assert.ok(r.html.includes("Merci, c'est note.") && !r.html.includes("Ancien message"));
	assert.ok(r.text.endsWith("wrote:\nMerci, c'est note."), r.text);
});

test("last, Gmail : transfert range tout dans gmail_quote -> message entier", () => {
	const fwd = `<div dir="ltr"><br></div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br></div><div>Contenu transfere</div></div>`;
	const s = stripQuotedHtml(fwd);
	assert.equal(s.stripped, false);
	assert.equal(s.html, fwd);
});

const OUTLOOK_EN = `<html><body><div class="WordSection1"><p class="MsoNormal">Approved, go ahead.</p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>From:</b> Samuel &lt;s@x&gt;<br><b>Sent:</b> Monday 2 November 2026 09:00<br><b>To:</b> Jean<br><b>Subject:</b> Devis</p></div></div><p class="MsoNormal">Ancien message</p></div></body></html>`;

test("last, Outlook (From/Sent, bloc border-top) : coupe au bloc, balises refermees", () => {
	const s = stripQuotedHtml(OUTLOOK_EN);
	assert.equal(s.stripped, true);
	assert.ok(s.html.includes("Approved, go ahead."));
	assert.ok(!s.html.includes("Ancien message") && !s.html.includes("<b>From:</b>"));
	assert.ok(s.html.endsWith("</o:p></p></div></body></html>"), s.html);
});

const OUTLOOK_FR = `<div class="WordSection1"><p class="MsoNormal"><span lang="FR">Oui pour moi.</span></p><hr><p class="MsoNormal"><b><span lang="FR">De&nbsp;:</span></b><span lang="FR"> Samuel</span><br><b><span lang="FR">Envoyé&nbsp;:</span></b> lundi 2 novembre 2026 09:00</p><p>Ancien</p></div>`;

test("last, Outlook francais (De/Envoye avec <hr>) : coupe a partir du <hr>", () => {
	const s = stripQuotedHtml(OUTLOOK_FR);
	assert.equal(s.stripped, true);
	assert.equal(s.html, `<div class="WordSection1"><p class="MsoNormal"><span lang="FR">Oui pour moi.</span></p></div>`);
});

test("last, Outlook web (divRplyFwdMsg) et Original Message", () => {
	const owa = `<div>Yes.</div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> X<br><b>Sent:</b> y</font></div><div>old</div>`;
	assert.equal(stripQuotedHtml(owa).html, "<div>Yes.</div>");
	const om = `<p>Done.</p><p><b>-----Original Message-----</b><br>From: X</p><p>old</p>`;
	assert.equal(stripQuotedHtml(om).html, "<p>Done.</p>");
	const omfr = `<p>Fait.</p><p>-----Message d'origine-----<br>De : X</p>`;
	assert.equal(stripQuotedHtml(omfr).html, "<p>Fait.</p>");
});

test("last, Apple Mail : blockquote type=cite et ligne d'attribution retiree", () => {
	const apple = `<div dir="auto">Parfait.<br><br><div>On 2 Nov 2026, at 09:00, Samuel &lt;<a href="mailto:s@x">s@x</a>&gt; wrote:</div><br><blockquote type="cite"><div>Ancien</div></blockquote></div>`;
	const s = stripQuotedHtml(apple);
	assert.equal(s.stripped, true);
	assert.equal(s.html, `<div dir="auto">Parfait.</div>`);
});

test("last, Thunderbird : moz-cite-prefix puis blockquote", () => {
	const tb = `<p>D'accord.</p><div class="moz-cite-prefix">Le 02/11/2026 à 09:00, Samuel a écrit :<br></div><blockquote type="cite"><p>Ancien</p></blockquote>`;
	assert.equal(stripQuotedHtml(tb).html, "<p>D'accord.</p>");
});

test("last, texte : lignes « > », bloc Outlook texte, message sans historique", () => {
	assert.equal(stripQuotedText("Oui.\n\nOn Mon, Samuel wrote:\n> old\n> old2"), "Oui.");
	assert.equal(stripQuotedText("Oui.\n\n> old"), "Oui.");
	assert.equal(stripQuotedText("Oui.\n\n________________________________\nDe : Samuel\nEnvoyé : lundi\n\nold"), "Oui.");
	assert.equal(stripQuotedText("Oui.\n-----Message d'origine-----\nDe : X"), "Oui.");
	assert.equal(stripQuotedText("Rien a couper.\n\nJean"), "Rien a couper.\n\nJean");
	assert.equal(stripQuotedText("> tout cite"), "> tout cite");
});

test("last, message sans historique : cite en entier, identique a thread", () => {
	const a = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig, quoteScope: "last" });
	const b = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig, quoteScope: "thread" });
	assert.equal(a.html, b.html);
	assert.equal(a.text, b.text);
});

test("last, message texte seul : <pre> echappe du texte coupe, pas textAsHtml", () => {
	const r = composeMessage({
		mode: "reply",
		text: "ok",
		html: "<p>ok</p>",
		orig: { ...orig, html: null, text: "Oui <ok>.\n\n> old", textAsHtml: "<p>Oui &lt;ok&gt;.</p><p>&gt; old</p>" },
		quoteScope: "last",
	});
	assert.ok(r.html.includes('<pre style="white-space:pre-wrap;margin:0;">Oui &lt;ok&gt;.</pre>'), r.html);
	assert.ok(!r.html.includes("old"));
});

test("last + RFC : dernier message cite, puis la reponse, puis « -- » et la signature", () => {
	const r = composeMessage({
		mode: "reply",
		text: "Parfait, merci.",
		html: "<p>Parfait, merci.</p>",
		signatureHtml: SIG,
		orig: { ...orig, html: GMAIL, text: "Merci, c'est note.\n\n-- \nJean\n\nLe lun. 2 nov. 2026 à 09:00, Samuel <s@x> a écrit :\n> Ancien message" },
		rfcStyle: true,
		quoteScope: "last",
	});
	assert.equal(
		r.text,
		`On 02 Nov 2026, 09:15, Jean Client <jean@client.example> wrote:\n> Merci, c'est note.\n\nParfait, merci.\n\n-- \n${SIG_TEXT}`,
	);
	assert.ok(!r.html.includes("Ancien message"));
	assert.ok(r.html.indexOf("<blockquote") < r.html.indexOf("<p>Parfait, merci.</p>"));
	assert.ok(r.html.endsWith(`${SIG}</div>`));
});

test("quoteScope absent ou inconnu = thread", () => {
	const a = composeMessage({ mode: "reply", text: "ok", orig: { ...orig, html: GMAIL } });
	const b = composeMessage({ mode: "reply", text: "ok", orig: { ...orig, html: GMAIL }, quoteScope: "thread" });
	assert.equal(a.html, b.html);
	assert.ok(a.html.includes("Ancien message"));
});

test("closeOpenTags : balises ouvertes refermees, void et commentaires ignores", () => {
	assert.equal(closeOpenTags("<div><p>a<br><img src=x>"), "<div><p>a<br><img src=x></p></div>");
	assert.equal(closeOpenTags("<div><!-- <span> --><b>x</b>"), "<div><!-- <span> --><b>x</b></div>");
	assert.equal(closeOpenTags("<p>a</p>"), "<p>a</p>");
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
