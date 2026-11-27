// Samuel le 27/11/2026 : « ce qu'il faudrait voir, c'est l'email de la derniere personne a avoir
// envoye un mail dans le thread. Comme ca, si c'est moi, je vois bien que c'est moi. Et si c'est
// Delphine qui avait repondu, on aurait Delphine comme contact. » Cas d'origine : fil
// « Informations liaison IA », mon envoi de 06:55 puis le « Merci » de Delphine a 06:56, la ligne
// affichait « Delphine Servouze, Samuel Legros, H... » et le fil en gras passait pour mon mail.
// Lancement : docker compose -f compose.tools.yml exec -T node scripts/test.sh web apps/web/test/last-sender.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lastSender, lastSenderLabel } from "../lib/last-sender";

const own = new Set(["samuel@ss2i-digital.fr"]);
const delphine = { n: "Delphine Servouze", e: "delphine.servouze@antellia.fr" };
const moi = { n: "Samuel Legros", e: "samuel@ss2i-digital.fr" };

// 1) Cas d'origine : Delphine a repondu en dernier -> Delphine seule.
assert.equal(lastSenderLabel({ from: [delphine, moi] }), "Delphine Servouze");

// 2) J'ai ecrit en dernier -> mon nom (classique) ou « moi » (nouvelle interface).
assert.equal(lastSenderLabel({ from: [moi, delphine] }), "Samuel Legros");
assert.equal(lastSenderLabel({ from: [{ n: "", e: "Samuel@SS2I-digital.fr" }, delphine] }, { own, me: "moi" }), "moi");

// 3) Pas de nom -> l'adresse ; adresse vide ignoree ; aucun expediteur -> repli.
assert.equal(lastSenderLabel({ from: [{ n: " ", e: "jb@ss2i-digital.fr" }] }), "jb@ss2i-digital.fr");
assert.deepEqual(lastSender({ from: [{ n: "X", e: "" }, delphine] }), delphine);
assert.equal(lastSenderLabel({ from: [] }), "(inconnu)");
assert.equal(lastSenderLabel(null, { unknown: "?" }), "?");

// 4) Cablage : les trois listes (classique, mobile, nouvelle interface) passent par lastSenderLabel.
const root = join(__dirname, "..");
for (const f of [
	"components/mailbox/default/webmail-list-item.tsx",
	"components/mailbox/default/webmail-list-item-mobile.tsx",
	"components/k/thread-row.tsx",
]) {
	assert.match(readFileSync(join(root, f), "utf8"), /lastSenderLabel\(/, `${f} : colonne De = dernier expediteur`);
}

console.log("last-sender : ok");
