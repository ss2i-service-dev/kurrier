// Deplacement d'un destinataire entre To, Cc et Bcc (apps/web editor/recipients-move.ts) :
// pur, sans DOM. Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/recipients-move.ts
import assert from "node:assert/strict";
import { addRecipients, moveRecipient } from "../../web/components/mailbox/default/editor/recipients-move";

const base = { to: ["a@x.fr", "b@x.fr"], cc: ["c@x.fr"], bcc: [] as string[] };

let r = moveRecipient(base, "a@x.fr", "to", "cc");
assert.deepEqual(r, { to: ["b@x.fr"], cc: ["c@x.fr", "a@x.fr"], bcc: [] });
assert.deepEqual(base.to, ["a@x.fr", "b@x.fr"], "entree non modifiee");

r = moveRecipient(base, "C@X.fr", "cc", "to");
assert.deepEqual(r, { to: ["a@x.fr", "b@x.fr", "C@X.fr"], cc: [], bcc: [] });

// deja present dans la cible (casse ignoree) : retire de la source, pas de doublon
r = moveRecipient(base, "A@x.fr", "to", "cc");
assert.deepEqual(r.cc, ["c@x.fr", "A@x.fr"]);
r = moveRecipient({ to: ["a@x.fr"], cc: ["A@X.FR"], bcc: [] }, "a@x.fr", "to", "cc");
assert.deepEqual(r, { to: [], cc: ["A@X.FR"], bcc: [] });

// meme champ : rien
assert.equal(moveRecipient(base, "a@x.fr", "to", "to"), base);

assert.deepEqual(addRecipients(["a@x.fr"], ["a@x.fr", "b@x.fr", " "]), ["a@x.fr", "b@x.fr"]);
console.log("recipients-move : ok");
