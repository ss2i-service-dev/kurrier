// Samuel le 18/11/2026 : « à chaque fois que j'envoie un mail, il arrive dans ma boîte en non
// lu [...] Si j'ai envoyé un mail, il est lu, vu que je l'ai envoyé ». La base etait juste
// (copie dev@ enregistree lue depuis le 06/11) : c'est le liseré « arrive depuis la lecture »
// de la liste (8ddc39ce) qui se fiait a last_activity_at. Une reponse envoyee le change (fil
// remonte, OI 10273) et la copie recue par dev@ aussi : le fil repassait non lu a l'ecran.
// Desormais seul un message d'un autre, arrive dans ce dossier, rallume le liseré.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/own-reply-not-unread.ts
import assert from "node:assert/strict";
import { createArrivalTracker } from "../lib/arrival-tracker";

const own = new Set(["samuel@ss2i-digital.fr"]);
const row = (count: number, lastFrom: string) => ({ count, lastFrom });

// 1) Fil ouvert, je reponds : le fil remonte (date changee), meme nombre de messages ici.
{
	const t = createArrivalTracker();
	assert.equal(t.arrived("A", row(2, "jb@ss2i-digital.fr"), own, true), false);
	assert.equal(t.arrived("A", row(2, "jb@ss2i-digital.fr"), own, false), false, "reponse envoyee : pas de liseré");
}

// 2) Ma copie revient par dev@ dans la boite de reception : un message de plus, de moi.
{
	const t = createArrivalTracker();
	t.arrived("B", row(2, "jb@ss2i-digital.fr"), own, true);
	assert.equal(t.arrived("B", row(3, "Samuel@SS2I-digital.fr"), own, false), false, "ma copie : pas de liseré");
}

// 3) Un collegue repond pendant que le fil est ouvert : liseré, et il reste jusqu'a la relecture.
{
	const t = createArrivalTracker();
	t.arrived("C", row(2, "jb@ss2i-digital.fr"), own, true);
	assert.equal(t.arrived("C", row(3, "hugo@ss2i-services.fr"), own, false), true);
	assert.equal(t.arrived("C", row(3, "hugo@ss2i-services.fr"), own, false), true, "liseré garde");
	assert.equal(t.arrived("C", row(4, "samuel@ss2i-digital.fr"), own, false), true, "ma reponse ne l'efface pas");
	t.reset("C");
	assert.equal(t.arrived("C", row(4, "samuel@ss2i-digital.fr"), own, true), false, "relu : plus de liseré");
}

// 4) Fil jamais ouvert : pas de suivi, rien a signaler (le non-lu vient du serveur).
{
	const t = createArrivalTracker();
	assert.equal(t.arrived("D", row(1, "x@y.fr"), own, false), false);
	assert.equal(t.arrived("D", row(2, "x@y.fr"), own, false), false);
}

// 5) Un message quitte le dossier (archive) puis un autre arrive : compte repris a la baisse.
{
	const t = createArrivalTracker();
	t.arrived("E", row(3, "x@y.fr"), own, true);
	assert.equal(t.arrived("E", row(2, "x@y.fr"), own, false), false);
	assert.equal(t.arrived("E", row(3, "z@y.fr"), own, false), true);
}

console.log("own-reply-not-unread : ok");
