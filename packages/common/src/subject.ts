// ss2i : objet sans préfixe de réponse ni de transfert (Samuel le 06/11 : « tous les mails
// qu'on a, ils se retrouvent avec des RE:, des forward: [...] tu me dégages cette merde »).
// Les clients empilent « RE: TR: RE: Fwd: » (Outlook en majuscules, en français TR:, en
// allemand AW:/WG:, etc.). Courrier n'en ajoute plus aucun en réponse ni en transfert et
// n'en affiche plus : le fil tient par In-Reply-To et References, pas par l'objet.

// Préfixes connus, en minuscules : anglais, français, allemand, nordiques, néerlandais,
// italien, espagnol, portugais. Un préfixe peut porter un compteur (« Re[2]: », « RE(3): »)
// et le deux-points peut être pleine chasse (« ： »).
const PREFIXES = [
	"re",
	"ré",
	"fw",
	"fwd",
	"tr",
	"trans",
	"aw",
	"wg",
	"sv",
	"vs",
	"vb",
	"antw",
	"doorst",
	"rif",
	"rv",
	"enc",
	"res",
];

const PREFIX_RE = new RegExp(
	`^\\s*(?:${PREFIXES.join("|")})\\s*(?:\\[\\d+\\]|\\(\\d+\\))?\\s*[:：]\\s*`,
	"iu",
);

/** Objet débarrassé de tous les préfixes de réponse et de transfert en tête, empilés ou non. */
export function stripSubjectPrefixes(subject: string | null | undefined): string {
	let s = (subject ?? "").trim();
	for (;;) {
		const next = s.replace(PREFIX_RE, "");
		if (next === s) return s;
		s = next.trim();
	}
}
