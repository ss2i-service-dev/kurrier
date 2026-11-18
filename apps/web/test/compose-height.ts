// Interface classique, nouveau message : la fenetre ancree en bas a droite etait en h-auto sans
// hauteur maximale. Un texte long la faisait grandir au-dela de l'ecran : son haut (destinataires,
// objet, debut du texte) sortait par le haut de la fenetre du navigateur, hors d'atteinte
// (Samuel le 18/11 : « on a un pb de presentation quand on redige un brouillon from scratch »).
// La fenetre est maintenant bornee a la hauteur de l'ecran, son contenu defile a l'interieur, et
// la barre d'envoi reste collee en bas de la zone qui defile. Elle prend aussi toute la hauteur de
// l'ecran et jusqu'a 960 px de large, la zone de texte remplissant l'espace (au lieu de 520 px).
// Lance par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/compose-height.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failures = 0;
const test = (label: string, fn: () => void) => {
	try {
		fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const compose = src("components/mailbox/default/compose-mail.tsx");

test("la fenetre du nouveau message ne depasse jamais la hauteur de l'ecran", () => {
	assert.ok(compose.includes("max-h-[calc(100dvh-2rem)]"), "hauteur maximale bornee a l'ecran");
	assert.doesNotMatch(compose, /"max-h-none"/, "plus de max-h-none sur le corps");
	assert.match(compose, /fixed z-\[1000\][^"]*flex flex-col/, "fenetre en colonne flexible");
});
test("la fenetre exploite l'espace de l'ecran (Samuel le 18/11)", () => {
	assert.ok(compose.includes("w-[min(960px,calc(100vw-6rem))]"), "largeur jusqu'a 960 px");
	assert.ok(compose.includes("h-[calc(100dvh-2rem)]"), "toute la hauteur de l'ecran");
	assert.doesNotMatch(compose, /w-\[520px\]/, "plus de fenetre etroite de 520 px");
	const css = src("app/ss2i-ui.css");
	// Interface classique : RichTextEditor.Content rend un wrapper Typography (prose, min-h-96) enfant
	// direct de la racine, qui contient .mantine-RichTextEditor-content ; sans lui la zone restait a 52 px.
	assert.match(css, /\.ss2i-compose-scroll \.mantine-RichTextEditor-root > \.mantine-RichTextEditor-Typography,\s*\.ss2i-compose-scroll \.mantine-RichTextEditor-content\s*\{[^}]*flex: 1 0 auto;/, "zone de texte qui remplit la fenetre");
	assert.match(css, /:not\(\.mantine-RichTextEditor-content\):not\(\.mantine-RichTextEditor-Typography\)/, "le wrapper Typography n'est pas fige");
});
test("le contenu de la fenetre defile a l'interieur", () => {
	assert.match(compose, /ss2i-compose-scroll min-h-0 overflow-y-auto/, "corps de la fenetre en defilement");
});
test("la barre d'envoi reste visible en bas de la zone qui defile", () => {
	const css = src("app/globals.css") + src("app/ss2i-ui.css");
	assert.match(css, /\.ss2i-compose-scroll \.mantine-RichTextEditor-root > \.border-t\s*\{[^}]*position: sticky;[^}]*bottom: 0;/, "barre d'envoi collante");
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntous les controles passent");
