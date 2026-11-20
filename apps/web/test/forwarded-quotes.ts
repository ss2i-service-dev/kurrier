// Citations repliées par défaut seulement quand on a déjà lu ce qu'elles contiennent.
// Samuel le 20/11/2026, sur « [IUT La Rochelle] Proposer un stage en BUT Informatique » transféré
// par Hugo : le lecteur n'affichait que « Forwarded message: », « On 19 Nov 2026 ... wrote: » et
// le bouton « Show previous messages ». « Si jamais on n'a jamais participé à une conversation et
// qu'on a un message qui nous est forwardé, on veut le voir. »
// Ce test est lancé par Dockerfile.web avant le build : rouge = pas d'image.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/forwarded-quotes.ts
import assert from "node:assert/strict";
import { hideQuotesByDefault, isForwardedMessage } from "../lib/quote-visibility";

const IUT_HTML =
	'<div dir="ltr"><br><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Forwarded message:<br></div><br><div class="gmail_quote"><div>On 19 Nov 2026, 14:58, &lt;jmalki@univ-lr.fr&gt; wrote:</div><blockquote type="cite">Bonjour, ...</blockquote></div></div></div>';
const REPLY_HTML =
	'<div>Merci, c\'est noté.</div><div class="gmail_quote"><div class="gmail_attr">Le jeu. 19 nov. 2026, Samuel a écrit :</div><blockquote class="gmail_quote">Bonjour</blockquote></div>';

// Détection d'un transfert : objet ou marqueur des clients courants.
assert.equal(isForwardedMessage({ subject: "[IUT La Rochelle] Proposer un stage", html: IUT_HTML }), true);
assert.equal(isForwardedMessage({ subject: "Fwd: Devis", html: "<p>voir plus bas</p>" }), true);
assert.equal(isForwardedMessage({ subject: "TR: SOAP LIBAUD", html: "<p>Pour info</p>" }), true);
assert.equal(isForwardedMessage({ subject: "Fw: test", html: "" }), true);
assert.equal(
	isForwardedMessage({ subject: "Demande", html: "<div>---------- Forwarded message ---------<br>De : x</div>" }),
	true,
);
assert.equal(isForwardedMessage({ subject: "Demande", html: "<div>-------- Message transféré --------</div>" }), true);
assert.equal(isForwardedMessage({ subject: "Demande", html: "<p>Begin forwarded message:</p>" }), true);
assert.equal(isForwardedMessage({ subject: "Demande", html: "<p>-----Original Message-----</p>" }), true);
assert.equal(isForwardedMessage({ subject: "Demande", html: "<p>-----Message d'origine-----</p>" }), true);
assert.equal(isForwardedMessage({ subject: "Re: Devis", html: REPLY_HTML }), false);
assert.equal(isForwardedMessage({ subject: null, html: null, text: "---------- Forwarded message ---------" }), true);
assert.equal(isForwardedMessage({ subject: null, html: null, text: null }), false);

// Un transfert est toujours déplié, même seul dans le fil (le cas signalé) ou plus loin dans le fil.
assert.equal(hideQuotesByDefault({ threadIndex: 0, subject: "[IUT La Rochelle] Proposer un stage", html: IUT_HTML }), false);
assert.equal(hideQuotesByDefault({ threadIndex: 2, subject: "Fwd: Devis", html: "<p>x</p>" }), false);

// Premier message du fil chez nous : on n'a jamais vu ce qu'il cite (réponse d'une conversation
// à laquelle on n'a pas participé, mise en copie en cours de route) -> déplié.
assert.equal(hideQuotesByDefault({ threadIndex: 0, subject: "Re: Devis", html: REPLY_HTML }), false);

// Réponse dans un fil dont les messages précédents sont affichés au-dessus -> replié, comme avant.
assert.equal(hideQuotesByDefault({ threadIndex: 1, subject: "Re: Devis", html: REPLY_HTML }), true);

// Index inconnu (appelant qui ne le passe pas) : comportement d'avant, replié sauf transfert.
assert.equal(hideQuotesByDefault({ subject: "Re: Devis", html: REPLY_HTML }), true);
assert.equal(hideQuotesByDefault({ subject: "Fwd: Devis", html: REPLY_HTML }), false);

// Les deux interfaces passent l'index chronologique au lecteur.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const web = join(__dirname, "..");
for (const f of ["components/mailbox/default/thread-item.tsx", "components/k/thread-item.tsx"]) {
	const src = readFileSync(join(web, f), "utf8");
	assert.match(src, /<EmailViewer[^>]*threadIndex=\{threadIndex\}/, `${f} : EmailViewer reçoit threadIndex`);
}
const viewer = readFileSync(join(web, "components/mailbox/default/email-viewer.tsx"), "utf8");
assert.match(viewer, /hideQuotesByDefault\(/, "email-viewer : état initial des citations par hideQuotesByDefault");

console.log("forwarded-quotes : OK");
