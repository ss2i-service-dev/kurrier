// Quotes are folded by default only when what they contain has already been read.
// Case reported on a forwarded newsletter-style mail: the reader only showed "Forwarded message:",
// "On 19 Nov 2026 ... wrote:" and the "Show previous messages" button. If we never took part in a
// conversation and a message from it is forwarded to us, we want to see it.
// Run (from the root):
//   node_modules/.bin/tsx apps/web/test/forwarded-quotes.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hideQuotesByDefault, isForwardedMessage } from "../lib/quote-visibility";

const FORWARD_HTML =
	'<div dir="ltr"><br><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Forwarded message:<br></div><br><div class="gmail_quote"><div>On 19 Nov 2026, 14:58, &lt;alice@example.org&gt; wrote:</div><blockquote type="cite">Hello, ...</blockquote></div></div></div>';
const REPLY_HTML =
	'<div>Thanks, noted.</div><div class="gmail_quote"><div class="gmail_attr">On Thu, 19 Nov 2026, Bob wrote:</div><blockquote class="gmail_quote">Hello</blockquote></div>';

// Forward detection: subject or marker of the common clients.
assert.equal(isForwardedMessage({ subject: "[Newsletter] Offer", html: FORWARD_HTML }), true);
assert.equal(isForwardedMessage({ subject: "Fwd: Quote", html: "<p>see below</p>" }), true);
assert.equal(isForwardedMessage({ subject: "TR: Order", html: "<p>FYI</p>" }), true);
assert.equal(isForwardedMessage({ subject: "Fw: test", html: "" }), true);
assert.equal(
	isForwardedMessage({ subject: "Request", html: "<div>---------- Forwarded message ---------<br>From: x</div>" }),
	true,
);
assert.equal(isForwardedMessage({ subject: "Request", html: "<div>-------- Message transféré --------</div>" }), true);
assert.equal(isForwardedMessage({ subject: "Request", html: "<p>Begin forwarded message:</p>" }), true);
assert.equal(isForwardedMessage({ subject: "Request", html: "<p>-----Original Message-----</p>" }), true);
assert.equal(isForwardedMessage({ subject: "Request", html: "<p>-----Message d'origine-----</p>" }), true);
assert.equal(isForwardedMessage({ subject: "Re: Quote", html: REPLY_HTML }), false);
assert.equal(isForwardedMessage({ subject: null, html: null, text: "---------- Forwarded message ---------" }), true);
assert.equal(isForwardedMessage({ subject: null, html: null, text: null }), false);

// A forward is always unfolded, even alone in the thread (the reported case) or further down.
assert.equal(hideQuotesByDefault({ threadIndex: 0, subject: "[Newsletter] Offer", html: FORWARD_HTML }), false);
assert.equal(hideQuotesByDefault({ threadIndex: 2, subject: "Fwd: Quote", html: "<p>x</p>" }), false);

// First message of the thread on our side: we never saw what it quotes (reply of a conversation
// we did not take part in, copied in along the way) -> unfolded.
assert.equal(hideQuotesByDefault({ threadIndex: 0, subject: "Re: Quote", html: REPLY_HTML }), false);

// Reply in a thread whose previous messages are displayed above -> folded, as before.
assert.equal(hideQuotesByDefault({ threadIndex: 1, subject: "Re: Quote", html: REPLY_HTML }), true);

// Unknown index (caller that does not pass it): previous behavior, folded except for a forward.
assert.equal(hideQuotesByDefault({ subject: "Re: Quote", html: REPLY_HTML }), true);
assert.equal(hideQuotesByDefault({ subject: "Fwd: Quote", html: REPLY_HTML }), false);

// Both interfaces pass the chronological index to the reader.
const web = join(__dirname, "..");
for (const f of ["components/mailbox/default/thread-item.tsx", "components/k/thread-item.tsx"]) {
	const src = readFileSync(join(web, f), "utf8");
	assert.match(src, /<EmailViewer[^>]*threadIndex=\{threadIndex\}/, `${f}: EmailViewer receives threadIndex`);
}
const viewer = readFileSync(join(web, "components/mailbox/default/email-viewer.tsx"), "utf8");
assert.match(viewer, /hideQuotesByDefault\(/, "email-viewer: initial quote state from hideQuotesByDefault");

console.log("forwarded-quotes: OK");
