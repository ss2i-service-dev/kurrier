// Assembly of the body of outgoing messages (packages/common/src/compose.ts): default style
// unchanged (non-regression), RFC style (quote, reply, "-- " + signature), quote scope
// (last message only / whole thread) and cutting of Gmail, Outlook, Apple and plain-text
// histories. No database, no Redis. Run (from the repository root):
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/compose-body.ts
import assert from "node:assert/strict";
import {
	closeOpenTags,
	composeMessage,
	keepEmptyLines,
	formatQuoteDate,
	isPlainHtml,
	quoteOverrideOf,
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

const SIG = `<table><tr><td>Jane Doe<br>Example Corp</td></tr></table>`;
const SIG_TEXT = "Jane Doe\nExample Corp";

const orig: ComposeOriginal = {
	subject: "Server quote",
	fromName: "Bob Smith",
	fromAddress: "bob@example.org",
	dateLabel: "02 Nov 2026, 09:15",
	text: "Hello,\n\nCan you send a quote?\n\nBob",
	html: "<div>Hello,</div><div><br></div><div>Can you send a quote?</div><div><br></div><div>Bob</div>",
};

// --- Default style: output identical to the former generateMailAttrs ----------------------

test("default, reply: reply, signature, then quote (exact text and HTML)", () => {
	const r = composeMessage({
		mode: "reply",
		text: "Yes, tomorrow.",
		html: "<p>Yes, tomorrow.</p>",
		signatureHtml: SIG,
		orig,
	});
	assert.equal(r.subject, "Re: Server quote");
	assert.equal(
		r.text,
		`Yes, tomorrow.\n\n-- \n${SIG_TEXT}\n\nOn 02 Nov 2026, 09:15, Bob Smith <bob@example.org> wrote:\n${orig.text}`,
	);
	assert.equal(
		r.html,
		`<p>Yes, tomorrow.</p><div class="signature" style="margin-top:1em">${SIG}</div><hr>
<p>On 02 Nov 2026, 09:15, Bob Smith &lt;bob@example.org&gt; wrote:</p>
<blockquote style="border-left:2px solid #ccc;margin:0;padding-left:8px;">
  ${orig.html}
</blockquote>`,
	);
});

test("default, forward: Forwarded message label, Fwd:", () => {
	const r = composeMessage({ mode: "forward", text: "FYI", html: "<p>FYI</p>", signatureHtml: SIG, orig });
	assert.equal(r.subject, "Fwd: Server quote");
	assert.equal(
		r.text,
		`FYI\n\n-- \n${SIG_TEXT}\n\nForwarded message:\nOn 02 Nov 2026, 09:15, Bob Smith <bob@example.org> wrote:\n${orig.text}`,
	);
	assert.ok(r.html.startsWith(`<p>FYI</p><div class="signature" style="margin-top:1em">${SIG}</div><p>Forwarded message:</p><hr>`));
});

test("default, new: text and signature, no HTML separator; without a signature nothing is added", () => {
	const r = composeMessage({ mode: "new", subject: "Hello", text: "Hi", html: "<p>Hi</p>", signatureHtml: SIG });
	assert.equal(r.subject, "Hello");
	assert.equal(r.text, `Hi\n\n-- \n${SIG_TEXT}`);
	assert.equal(r.html, `<p>Hi</p><div class="signature" style="margin-top:1em">${SIG}</div>`);
	const none = composeMessage({ mode: "new", text: "Hi", html: "<p>Hi</p>", signatureHtml: "" });
	assert.equal(none.subject, "(no subject)");
	assert.equal(none.text, "Hi");
	assert.equal(none.html, "<p>Hi</p>");
});

test("default, Re:/Fwd: already present and empty subject", () => {
	assert.equal(composeMessage({ mode: "reply", orig: { ...orig, subject: "Re: X" } }).subject, "Re: X");
	assert.equal(composeMessage({ mode: "forward", orig: { ...orig, subject: "" } }).subject, "Fwd: (no subject)");
});

test("subject prefixes option: off keeps Re:/Fwd:, on strips the stacked ones", () => {
	const stacked = { ...orig, subject: "RE: TR: Server quote" };
	assert.equal(composeMessage({ mode: "reply", orig: stacked }).subject, "Re: RE: TR: Server quote");
	assert.equal(composeMessage({ mode: "reply", stripSubjectPrefixes: false, orig: stacked }).subject, "Re: RE: TR: Server quote");
	assert.equal(composeMessage({ mode: "reply", stripSubjectPrefixes: true, orig: stacked }).subject, "Server quote");
	assert.equal(composeMessage({ mode: "forward", stripSubjectPrefixes: true, orig: stacked }).subject, "Server quote");
	assert.equal(composeMessage({ mode: "forward", orig: stacked }).subject, "Fwd: RE: TR: Server quote");
});

test("default, thread scope without HTML: textAsHtml then unescaped <pre> (unchanged)", () => {
	const r = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig: { ...orig, html: null, textAsHtml: "<p>Hello</p>" } });
	assert.ok(r.html.includes("<p>Hello</p>"));
	const r2 = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig: { ...orig, html: null, text: "a <b> c" } });
	assert.ok(r2.html.includes('<pre style="white-space:pre-wrap;margin:0;">a <b> c</pre>'));
});

// --- Style RFC --------------------------------------------------------------------------

test("RFC, reply: quote prefixed with \"> \", then the reply, then \"-- \" and the signature", () => {
	const r = composeMessage({
		mode: "reply",
		text: "Yes, tomorrow.",
		html: "<p>Yes, tomorrow.</p>",
		signatureHtml: SIG,
		orig,
		rfcStyle: true,
	});
	assert.equal(
		r.text,
		`On 02 Nov 2026, 09:15, Bob Smith <bob@example.org> wrote:\n> Hello,\n>\n> Can you send a quote?\n>\n> Bob\n\nYes, tomorrow.\n\n-- \n${SIG_TEXT}`,
	);
	// The separator line is exactly "--" followed by a space.
	assert.ok(r.text.includes("\n-- \n"));
	assert.ok(!/\n--\n/.test(r.text));
	assert.ok(r.text.endsWith(SIG_TEXT));
	const iQuote = r.html.indexOf("<blockquote");
	const iBody = r.html.indexOf("<p>Yes, tomorrow.</p>");
	const iSig = r.html.indexOf('<div class="signature"');
	assert.ok(iQuote >= 0 && iQuote < iBody && iBody < iSig, "HTML order: quote, reply, signature");
	assert.ok(r.html.startsWith('<div class="quote-attribution">On 02 Nov 2026, 09:15, Bob Smith &lt;bob@example.org&gt; wrote:</div>'));
	assert.ok(r.html.includes('<div class="signature" style="margin-top:1em"><div style="white-space:pre">-- </div>'));
	assert.ok(!r.html.includes("<hr>"));
});

test("RFC, reply without a signature: no \"-- \"", () => {
	const r = composeMessage({ mode: "reply", text: "Yes", html: "<p>Yes</p>", orig, rfcStyle: true });
	assert.ok(!r.text.includes("-- "));
	assert.ok(r.text.endsWith("\n\nYes"));
});

test("RFC, forward: text, forwarded message, then \"-- \" and the signature at the very bottom", () => {
	const r = composeMessage({ mode: "forward", text: "FYI", html: "<p>FYI</p>", signatureHtml: SIG, orig, rfcStyle: true });
	assert.equal(
		r.text,
		`FYI\n\nForwarded message:\nOn 02 Nov 2026, 09:15, Bob Smith <bob@example.org> wrote:\n> Hello,\n>\n> Can you send a quote?\n>\n> Bob\n\n-- \n${SIG_TEXT}`,
	);
	assert.ok(r.html.endsWith(`${SIG}</div>`));
	assert.ok(r.html.indexOf("<p>FYI</p>") < r.html.indexOf("<blockquote"));
});

test("RFC, new: HTML signature with the \"-- \" line", () => {
	const r = composeMessage({ mode: "new", text: "Hi", html: "<p>Hi</p>", signatureHtml: SIG, rfcStyle: true });
	assert.equal(r.text, `Hi\n\n-- \n${SIG_TEXT}`);
	assert.equal(r.html, `<p>Hi</p><div class="signature" style="margin-top:1em"><div style="white-space:pre">-- </div>${SIG}</div>`);
});

test("RFC: the \"-- \" delimited signature of the original is removed from the quote", () => {
	const r = composeMessage({
		mode: "reply",
		text: "Noted.",
		html: "<p>Noted.</p>",
		orig: {
			...orig,
			text: "Hello,\n\nThanks.\n-- \nBob Smith\nTel 555",
			html: `<div>Hello,</div><div>Thanks.</div><div class="signature" style="margin-top:1em"><div style="white-space:pre">-- </div><b>Bob Smith</b></div>`,
		},
		rfcStyle: true,
	});
	assert.ok(r.text.includes("> Hello,\n>\n> Thanks.\n\nNoted."), r.text);
	assert.ok(!r.text.includes("Tel 555"));
	assert.ok(!r.html.includes("Bob Smith</b>"));
	assert.ok(r.html.includes("<div>Thanks.</div>\n</blockquote>"), r.html);
});

test("RFC: an undelimited signature stays in the quote (no heuristic)", () => {
	const r = composeMessage({ mode: "reply", text: "Noted.", orig: { ...orig, text: "Thanks.\n\nBob Smith\nOutlook" }, rfcStyle: true });
	assert.ok(r.text.includes("> Bob Smith\n> Outlook"));
});

test("RFC: existing quote levels are respected (>> )", () => {
	assert.equal(quoteTextLines("a\n> b\n>> c\n"), "> a\n>> b\n>>> c\n>");
	const r = composeMessage({ mode: "reply", text: "x", orig: { ...orig, text: "Yes\n> No" }, rfcStyle: true, quoteScope: "thread" });
	assert.ok(r.text.includes("> Yes\n>> No"));
});

test("RFC: HTML original without a text part -> text derived from the HTML for the quote", () => {
	const r = composeMessage({ mode: "reply", text: "x", orig: { ...orig, text: null }, rfcStyle: true });
	assert.ok(r.text.includes("> Hello,\n>\n> Can you send a quote?"), r.text);
});

test("stripSignatureText: only the exact \"-- \" line delimits", () => {
	assert.equal(stripSignatureText("a\n--\nb"), "a\n--\nb");
	assert.equal(stripSignatureText("a\n-- \nb"), "a");
	assert.equal(stripSignatureText("-- \nb"), "-- \nb");
	assert.equal(stripSignatureHtml(`<p>a</p><pre class="moz-signature" cols="72">-- \nBob</pre>`), "<p>a</p>");
	// Mail signature placed before a quote (default style): left alone.
	const mid = `<p>a</p><div class="signature"><div style="white-space:pre">-- </div>J</div><blockquote>q</blockquote>`;
	assert.equal(stripSignatureHtml(mid), mid);
});

// --- "Last message only" scope ----------------------------------------------------------

const GMAIL = `<div dir="ltr">Thanks, noted.</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Le lun. 2 nov. 2026 à 09:00, Alice &lt;<a href="mailto:s@x">s@x</a>&gt; a écrit :<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div>Old message</div></blockquote></div>`;

test("last, Gmail: only the own body is quoted", () => {
	const s = stripQuotedHtml(GMAIL);
	assert.equal(s.stripped, true);
	assert.equal(s.html, `<div dir="ltr">Thanks, noted.</div>`);
	const r = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig: { ...orig, html: GMAIL, text: "Thanks, noted.\n\nLe lun. 2 nov. 2026 à 09:00, Alice <s@x> a écrit :\n> Old message" }, quoteScope: "last" });
	assert.ok(r.html.includes("Thanks, noted.") && !r.html.includes("Old message"));
	assert.ok(r.text.endsWith("wrote:\nThanks, noted."), r.text);
});

test("last, Gmail: forward puts everything in gmail_quote -> whole message", () => {
	const fwd = `<div dir="ltr"><br></div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br></div><div>Forwarded content</div></div>`;
	const s = stripQuotedHtml(fwd);
	assert.equal(s.stripped, false);
	assert.equal(s.html, fwd);
});

const OUTLOOK_EN = `<html><body><div class="WordSection1"><p class="MsoNormal">Approved, go ahead.</p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>From:</b> Alice &lt;s@x&gt;<br><b>Sent:</b> Monday 2 November 2026 09:00<br><b>To:</b> Bob<br><b>Subject:</b> Quote</p></div></div><p class="MsoNormal">Old message</p></div></body></html>`;

test("last, Outlook (From/Sent, border-top block): cut at the block, tags closed", () => {
	const s = stripQuotedHtml(OUTLOOK_EN);
	assert.equal(s.stripped, true);
	assert.ok(s.html.includes("Approved, go ahead."));
	assert.ok(!s.html.includes("Old message") && !s.html.includes("<b>From:</b>"));
	assert.ok(s.html.endsWith("</o:p></p></div></body></html>"), s.html);
});

const OUTLOOK_FR = `<div class="WordSection1"><p class="MsoNormal"><span lang="FR">Oui pour moi.</span></p><hr><p class="MsoNormal"><b><span lang="FR">De&nbsp;:</span></b><span lang="FR"> Alice</span><br><b><span lang="FR">Envoyé&nbsp;:</span></b> lundi 2 novembre 2026 09:00</p><p>Old</p></div>`;

test("last, French Outlook (De/Envoye with <hr>): cut from the <hr>", () => {
	const s = stripQuotedHtml(OUTLOOK_FR);
	assert.equal(s.stripped, true);
	assert.equal(s.html, `<div class="WordSection1"><p class="MsoNormal"><span lang="FR">Oui pour moi.</span></p></div>`);
});

test("last, Outlook web (divRplyFwdMsg) et Original Message", () => {
	const owa = `<div>Yes.</div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> X<br><b>Sent:</b> y</font></div><div>old</div>`;
	assert.equal(stripQuotedHtml(owa).html, "<div>Yes.</div>");
	const om = `<p>Done.</p><p><b>-----Original Message-----</b><br>From: X</p><p>old</p>`;
	assert.equal(stripQuotedHtml(om).html, "<p>Done.</p>");
	const omfr = `<p>Fait.</p><p>-----Message d'origine-----<br>De: X</p>`;
	assert.equal(stripQuotedHtml(omfr).html, "<p>Fait.</p>");
});

test("last, Apple Mail: blockquote type=cite and attribution line removed", () => {
	const apple = `<div dir="auto">Perfect.<br><br><div>On 2 Nov 2026, at 09:00, Alice &lt;<a href="mailto:s@x">s@x</a>&gt; wrote:</div><br><blockquote type="cite"><div>Old</div></blockquote></div>`;
	const s = stripQuotedHtml(apple);
	assert.equal(s.stripped, true);
	assert.equal(s.html, `<div dir="auto">Perfect.</div>`);
});

test("last, Thunderbird: moz-cite-prefix then blockquote", () => {
	const tb = `<p>Okay.</p><div class="moz-cite-prefix">Le 02/11/2026 à 09:00, Alice a écrit :<br></div><blockquote type="cite"><p>Old</p></blockquote>`;
	assert.equal(stripQuotedHtml(tb).html, "<p>Okay.</p>");
});

test("last, text: \"> \" lines, Outlook text block, message without history", () => {
	assert.equal(stripQuotedText("Yes.\n\nOn Mon, Alice wrote:\n> old\n> old2"), "Yes.");
	assert.equal(stripQuotedText("Yes.\n\n> old"), "Yes.");
	assert.equal(stripQuotedText("Yes.\n\n________________________________\nDe: Alice\nEnvoyé: lundi\n\nold"), "Yes.");
	assert.equal(stripQuotedText("Yes.\n-----Message d'origine-----\nDe: X"), "Yes.");
	assert.equal(stripQuotedText("Nothing to cut.\n\nBob"), "Nothing to cut.\n\nBob");
	assert.equal(stripQuotedText("> all quoted"), "> all quoted");
});

test("last, message without history: quoted in full, same as thread", () => {
	const a = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig, quoteScope: "last" });
	const b = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig, quoteScope: "thread" });
	assert.equal(a.html, b.html);
	assert.equal(a.text, b.text);
});

test("last, plain-text message: escaped paragraphs of the cut text, not textAsHtml", () => {
	const r = composeMessage({
		mode: "reply",
		text: "ok",
		html: "<p>ok</p>",
		orig: { ...orig, html: null, text: "Yes <ok>.\n\n> old", textAsHtml: "<p>Yes &lt;ok&gt;.</p><p>&gt; old</p>" },
		quoteScope: "last",
	});
	assert.ok(r.html.includes("<p>Yes &lt;ok&gt;.</p>"), r.html);
	assert.ok(!r.html.includes("old"));
});

test("last + RFC: last message quoted, then the reply, then \"-- \" and the signature", () => {
	const r = composeMessage({
		mode: "reply",
		text: "Perfect, thanks.",
		html: "<p>Perfect, thanks.</p>",
		signatureHtml: SIG,
		orig: { ...orig, html: GMAIL, text: "Thanks, noted.\n\n-- \nBob\n\nLe lun. 2 nov. 2026 à 09:00, Alice <s@x> a écrit :\n> Old message" },
		rfcStyle: true,
		quoteScope: "last",
	});
	assert.equal(
		r.text,
		`On 02 Nov 2026, 09:15, Bob Smith <bob@example.org> wrote:\n> Thanks, noted.\n\nPerfect, thanks.\n\n-- \n${SIG_TEXT}`,
	);
	assert.ok(!r.html.includes("Old message"));
	assert.ok(r.html.indexOf("<blockquote") < r.html.indexOf("<p>Perfect, thanks.</p>"));
	assert.ok(r.html.endsWith(`${SIG}</div>`));
});

test("quoteScope absent or unknown = thread", () => {
	const a = composeMessage({ mode: "reply", text: "ok", orig: { ...orig, html: GMAIL } });
	const b = composeMessage({ mode: "reply", text: "ok", orig: { ...orig, html: GMAIL }, quoteScope: "thread" });
	assert.equal(a.html, b.html);
	assert.ok(a.html.includes("Old message"));
});

test("closeOpenTags: open tags closed, void elements and comments ignored", () => {
	assert.equal(closeOpenTags("<div><p>a<br><img src=x>"), "<div><p>a<br><img src=x></p></div>");
	assert.equal(closeOpenTags("<div><!-- <span> --><b>x</b>"), "<div><!-- <span> --><b>x</b></div>");
	assert.equal(closeOpenTags("<p>a</p>"), "<p>a</p>");
});

// --- Real-world case (MCP reply, quote=last, RFC style), plain-text original sent by
// the app: its HTML is the text laid out in paragraphs -----------------------------------

const PROD_TEXT = "Hello Alice,\n\nCan you confirm Thursday's slot?\n\n-- \nBob (Gmail)\n\nLe 1 nov. 2026, Old Client <old@example.net> a écrit :\n> Old history...\n> Second line...";
const PROD_HTML = "<p>Hello Alice,</p><p>Can you confirm Thursday's slot?</p><p>-- <br>Bob (Gmail)</p><p>Le 1 nov. 2026, Old Client &lt;old@example.net&gt; a écrit :<br>&gt; Old history...<br>&gt; Second line...</p>";

test("real case, last + RFC: text AND HTML only quote the own body, without signature or history", () => {
	const r = composeMessage({
		mode: "reply",
		text: "Yes, Thursday 10 am.",
		html: "<p>Yes, Thursday 10 am.</p>",
		signatureHtml: SIG,
		orig: { ...orig, text: PROD_TEXT, html: PROD_HTML, fromName: "Bob", fromAddress: "bob@example.com", dateLabel: "02 Nov 2026, 09:15" },
		rfcStyle: true,
		quoteScope: "last",
	});
	assert.equal(
		r.text,
		`On 02 Nov 2026, 09:15, Bob <bob@example.com> wrote:\n> Hello Alice,\n>\n> Can you confirm Thursday's slot?\n\nYes, Thursday 10 am.\n\n-- \n${SIG_TEXT}`,
	);
	assert.equal(
		r.html,
		`<div class="quote-attribution">On 02 Nov 2026, 09:15, Bob &lt;bob@example.com&gt; wrote:</div>
<blockquote type="cite" style="border-left:2px solid #ccc;margin:0;padding-left:8px;">
  <p>Hello Alice,</p><p>Can you confirm Thursday's slot?</p>
</blockquote>
<p>Yes, Thursday 10 am.</p><div class="signature" style="margin-top:1em"><div style="white-space:pre">-- </div>${SIG}</div>`,
	);
});

test("real case, same HTML without a text part: -- and &gt; landmarks recognized, attribution removed", () => {
	assert.equal(stripQuotedHtml(PROD_HTML).html, "<p>Hello Alice,</p><p>Can you confirm Thursday's slot?</p><p>-- <br>Bob (Gmail)</p>");
	assert.equal(stripSignatureHtml("<p>Hello Alice,</p><p>Can you confirm Thursday's slot?</p><p>-- <br>Bob (Gmail)</p>"), "<p>Hello Alice,</p><p>Can you confirm Thursday's slot?</p>");
	assert.equal(stripSignatureHtml("<div>a<br>-- <br>sig</div>"), "<div>a</div>");
	assert.equal(stripSignatureHtml("<div>a</div><div>--<br>not a separator</div>"), "<div>a</div><div>--<br>not a separator</div>");
	const r = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig: { ...orig, text: null, html: PROD_HTML }, rfcStyle: true, quoteScope: "last" });
	assert.ok(r.html.includes("<p>Can you confirm Thursday's slot?</p>\n</blockquote>"), r.html);
	assert.ok(!r.html.includes("Bob (Gmail)") && !r.html.includes("Old"));
	assert.ok(r.text.includes("> Can you confirm Thursday's slot?\n\nok"), r.text);
});

test("real case, thread scope outside RFC: output unchanged (original HTML kept as is)", () => {
	const r = composeMessage({ mode: "reply", text: "ok", html: "<p>ok</p>", orig: { ...orig, text: PROD_TEXT, html: PROD_HTML } });
	assert.ok(r.html.includes(PROD_HTML));
	assert.ok(r.text.endsWith(PROD_TEXT));
});

test("simple HTML recognized; rich HTML (table, img, blockquote) keeps its cleaned HTML", () => {
	assert.equal(isPlainHtml(PROD_HTML), true);
	assert.equal(isPlainHtml('<html><body><div dir="ltr">a <a href="x">link</a><br></div></body></html>'), true);
	assert.equal(isPlainHtml("<p>a</p><table><tr><td>b</td></tr></table>"), false);
	assert.equal(isPlainHtml(GMAIL), false);
	const rich = `<div><b>Bold</b> and <i>italic</i></div><blockquote><p>old</p></blockquote>`;
	const r = composeMessage({ mode: "reply", text: "ok", orig: { ...orig, text: "Bold and italic\n\n> old", html: rich }, quoteScope: "last" });
	assert.ok(r.html.includes("<div><b>Bold</b> and <i>italic</i></div>"));
});

test("formatQuoteDate: MAIL_TIMEZONE time zone, 24 h, English; default UTC", () => {
	const d = new Date("2026-11-02T08:15:00Z");
	assert.equal(formatQuoteDate(d, "Europe/Paris"), "02 Nov 2026, 09:15");
	assert.equal(formatQuoteDate(d, undefined), "02 Nov 2026, 08:15");
	assert.equal(formatQuoteDate(d, "UTC"), "02 Nov 2026, 08:15");
	assert.equal(formatQuoteDate(d, "America/Montreal"), "02 Nov 2026, 03:15");
	assert.equal(formatQuoteDate(new Date("2026-07-14T12:00:00Z"), "Europe/Paris"), "14 Jul 2026, 14:00");
	assert.equal(formatQuoteDate(d, "Not/AZone"), "02 Nov 2026, 08:15");
	assert.equal(formatQuoteDate(null, "Europe/Paris"), "");
});

// --- Sender signature, image card (identity with a single <img src="data:..."> of
// ~100 KB, empty derived text) -----------------------------------------------------------

const IMG_SIG = `<img src="data:image/png;base64,${"iVBORw0KGgo".repeat(9_000)}" alt="">`;
const TEXT_IMG_SIG = `<p>Kind regards,</p>${IMG_SIG}`;
const SIGNED_ORIG = {
	...orig,
	text: "Hello,\n\nThanks.\n\n-- \nBob Smith\n\nLe 1 nov. 2026, X <x@y> a écrit :\n> old",
	html: "<p>Hello,</p><p>Thanks.</p><p>-- <br>Bob Smith</p><p>Le 1 nov. 2026, X &lt;x@y&gt; a écrit :<br>&gt; old</p>",
};

for (const [label, sig, sigText] of [
	["image only", IMG_SIG, ""],
	["text \"Kind regards,\" + image", TEXT_IMG_SIG, "Kind regards,"],
] as const) {
	test(`signature ${label}, RFC + last: "-- " then the signature, text and HTML; the original's removed`, () => {
		const r = composeMessage({ mode: "reply", text: "Yes.", html: "<p>Yes.</p>", signatureHtml: sig, orig: SIGNED_ORIG, rfcStyle: true, quoteScope: "last" });
		assert.equal(r.text, `On 02 Nov 2026, 09:15, Bob Smith <bob@example.org> wrote:\n> Hello,\n>\n> Thanks.\n\nYes.\n\n-- \n${sigText}`);
		assert.ok(r.html.endsWith(`<div class="signature" style="margin-top:1em"><div style="white-space:pre">-- </div>${sig}</div>`), r.html.slice(-200));
		assert.equal(r.html.indexOf('class="signature"') > r.html.indexOf("<p>Yes.</p>"), true);
		assert.ok(!r.html.includes("Bob Smith</p>") && !r.html.includes("old"));
		const quoted = r.text.split("wrote:\n")[1];
		assert.ok(!quoted.includes("Bob Smith") && !quoted.includes("old"), quoted);
	});
	test(`signature ${label}, non-RFC + last: reply, "-- " + signature, then the quote (original's signature kept)`, () => {
		const r = composeMessage({ mode: "reply", text: "Yes.", html: "<p>Yes.</p>", signatureHtml: sig, orig: SIGNED_ORIG, quoteScope: "last" });
		assert.ok(r.text.startsWith(`Yes.\n\n-- \n${sigText}\n\nOn 02 Nov 2026, 09:15, Bob Smith <bob@example.org> wrote:\nHello,\n\nThanks.\n\n-- \nBob Smith`), r.text);
		assert.ok(r.html.startsWith(`<p>Yes.</p><div class="signature" style="margin-top:1em">${sig}</div><hr>`));
		assert.ok(r.html.includes("<p>-- <br>Bob Smith</p>") && !r.html.includes("old"));
	});
}

// In "thread" scope, the "-- " delimited signature of the original goes, but the history
// that follows it ("> " lines, attribution) stays quoted.
test("signature image only, RFC + thread: original's signature removed, its history kept, then \"-- \" + signature", () => {
	const r = composeMessage({ mode: "reply", text: "Yes.", html: "<p>Yes.</p>", signatureHtml: IMG_SIG, orig: SIGNED_ORIG, rfcStyle: true, quoteScope: "thread" });
	assert.ok(r.text.endsWith("> Thanks.\n>\n> Le 1 nov. 2026, X <x@y> a écrit :\n>> old\n\nYes.\n\n-- \n"), r.text);
	assert.ok(!r.text.includes("> Bob Smith"));
	// Simple HTML rebuilt from the cleaned text: same content.
	assert.ok(r.html.includes("<p>Hello,</p><p>Thanks.</p><p>Le 1 nov. 2026, X &lt;x@y&gt; a écrit :<br>&gt; old</p>"), r.html);
	assert.equal(stripSignatureText("a\n-- \nsig\n\n> q", { keepQuoteAfter: true }), "a\n\n> q");
	assert.equal(stripSignatureText("a\n-- \nsig\n\nOn Monday, X wrote:\n> q", { keepQuoteAfter: true }), "a\n\nOn Monday, X wrote:\n> q");
	assert.equal(stripSignatureText("a\n-- \nsig\n\n> q"), "a");
	const r2 = composeMessage({ mode: "reply", text: "Yes.", html: "<p>Yes.</p>", signatureHtml: IMG_SIG, orig: { ...orig, text: "Thanks.\n\n> old" }, rfcStyle: true, quoteScope: "thread" });
	assert.ok(r2.text.endsWith("> Thanks.\n>\n>> old\n\nYes.\n\n-- \n"), r2.text);
	assert.ok(r.html.endsWith(`${IMG_SIG}</div>`));
});

// --- Edited or removed quote (quoteOverride) ----------------------------------------------

const ORIG_SIG = { ...orig, text: "Hello,\n\nCan you send a quote?\n\n-- \nBob Smith\nACME", html: "<p>Hello,</p><p>Can you send a quote?</p><div class=\"signature\">-- <br>Bob Smith<br>ACME</div>" };
const EDITED = "<p>Can you send a quote?</p>";

test("quoteOverride custom, RFC: \"> \" text derived from the edited HTML, attribution kept", () => {
	const r = composeMessage({ mode: "reply", text: "Yes.", html: "<p>Yes.</p>", signatureHtml: SIG, orig: ORIG_SIG, rfcStyle: true, quoteOverride: { mode: "custom", html: EDITED } });
	assert.ok(r.text.startsWith("On 02 Nov 2026, 09:15, Bob Smith <bob@example.org> wrote:\n> Can you send a quote?\n\nYes."), r.text);
	assert.ok(!r.text.includes("ACME") && !r.html.includes("ACME"));
	assert.ok(!r.text.includes("Hello"));
	assert.ok(r.html.includes(`<blockquote type="cite"`) && r.html.includes(EDITED));
	assert.ok(r.html.includes("quote-attribution") && r.html.includes("Bob Smith"));
});

test("quoteOverride custom, default style: hr wrapper + attribution + blockquote", () => {
	const r = composeMessage({ mode: "reply", text: "Yes.", html: "<p>Yes.</p>", orig: ORIG_SIG, quoteOverride: { mode: "custom", html: EDITED } });
	assert.equal(r.text, "Yes.\n\nOn 02 Nov 2026, 09:15, Bob Smith <bob@example.org> wrote:\nCan you send a quote?");
	assert.ok(r.html.startsWith("<p>Yes.</p><hr>\n<p>On 02 Nov 2026, 09:15, Bob Smith &lt;bob@example.org&gt; wrote:</p>\n<blockquote"), r.html);
	assert.ok(r.html.includes(EDITED) && !r.html.includes("ACME"));
});

test("quoteOverride none: no attribution or blockquote, default and RFC styles", () => {
	for (const rfcStyle of [false, true]) {
		const r = composeMessage({ mode: "reply", text: "Yes.", html: "<p>Yes.</p>", signatureHtml: SIG, orig, rfcStyle, quoteOverride: { mode: "none" } });
		assert.equal(r.subject, "Re: Server quote");
		assert.ok(!/wrote|blockquote|<hr|quote-attribution|Bob/.test(r.text + r.html), r.text + r.html);
		assert.ok(r.text.startsWith("Yes.") && r.html.startsWith("<p>Yes.</p>"));
		assert.ok(r.text.includes(SIG_TEXT));
	}
});

test("forward: none ignored, custom replaces the forwarded body, null and absent unchanged", () => {
	const base = { mode: "forward" as const, text: "See below.", html: "<p>Voir</p>", orig };
	const ref = composeMessage(base);
	assert.deepEqual(composeMessage({ ...base, quoteOverride: { mode: "none" } }), ref);
	const edited = composeMessage({ ...base, quoteOverride: { mode: "custom", html: EDITED } });
	assert.ok(edited.html.includes(EDITED) && edited.html.includes("Forwarded message:"));
	assert.notDeepEqual(edited, ref);
	const rep = { mode: "reply" as const, text: "Yes.", html: "<p>Yes.</p>", orig, rfcStyle: true };
	assert.deepEqual(composeMessage({ ...rep, quoteOverride: null }), composeMessage(rep));
});

test("quoteOverrideOf: form / draft fields", () => {
	assert.deepEqual(quoteOverrideOf("none", ""), { mode: "none" });
	assert.deepEqual(quoteOverrideOf("custom", "<p>x</p>"), { mode: "custom", html: "<p>x</p>" });
	assert.equal(quoteOverrideOf("custom", "  "), null);
	assert.equal(quoteOverrideOf("auto", "<p>x</p>"), null);
	assert.equal(quoteOverrideOf(undefined, undefined), null);
});

test("empty lines: <p></p> goes out as <p><br></p> (body and edited quote)", () => {
	assert.equal(keepEmptyLines("<p>a</p><p></p><p>b</p>"), "<p>a</p><p><br></p><p>b</p>");
	assert.equal(keepEmptyLines('<p style="x"></p>'), '<p style="x"><br></p>');
	assert.equal(keepEmptyLines("<p>a</p>"), "<p>a</p>");
	const out = composeMessage({ html: "<p>Hello,</p><p></p><p>Thanks</p>", text: "x", subject: "s" } as any);
	assert.ok(out.html.startsWith("<p>Hello,</p><p><br></p><p>Thanks</p>"));
});

if (failures) {
	console.error(`\n${failures} failure(s)`);
	process.exit(1);
}
console.log("\nall ok");
