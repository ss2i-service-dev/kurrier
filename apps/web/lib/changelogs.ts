// ss2i (OI 10363) : notes de version « Nouveautes », sur le modele de Docator
// (packages/server/routes/changelogs.ts). Une note = un fichier markdown versionne dans
// apps/web/changelogs/, nomme AAAA-MM-JJ.md (suffixe -2, -3... pour une deuxieme note le
// meme jour). La version est le nom du fichier, jamais un champ du frontmatter, pour que
// les deux ne divergent pas ; `title: "..."` est obligatoire dans le frontmatter.
// Module pur (rien du systeme de fichiers) : le client l'importe aussi, pour le calcul des
// notes non vues. La lecture du dossier est dans lib/changelogs-files.ts.

export type ChangelogEntry = { version: string; title: string; markdown: string };

export const CHANGELOG_FILE = /^(\d{4}-\d{2}-\d{2}(?:-\d+)?)\.md$/;

// Aucun emoji ni pictogramme dans une note (regle de redaction SS2i) : refuse a la lecture
// du dossier par le test, et la note fautive n'est pas affichee en production.
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/u;

/** Date et rang du jour d'une version : 2026-11-06 -> rang 1, 2026-11-06-2 -> rang 2. */
function split(version: string): [string, number] {
	const m = /^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/.exec(version);
	return m ? [m[1], m[2] ? Number(m[2]) : 1] : [version, 1];
}

/** Ordre chronologique : < 0 si a est plus ancienne que b. */
export function compareVersions(a: string, b: string): number {
	const [da, na] = split(a);
	const [db, nb] = split(b);
	if (da !== db) return da < db ? -1 : 1;
	return na - nb;
}

/** Lit une note : frontmatter obligatoire avec un titre, pas d'emoji. Leve sinon. */
export function parseChangelog(fileName: string, raw: string): ChangelogEntry {
	const name = CHANGELOG_FILE.exec(fileName);
	if (!name) throw new Error(`${fileName} : nom attendu AAAA-MM-JJ.md (ou AAAA-MM-JJ-2.md)`);
	const text = raw.replace(/^﻿/, "");
	const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	if (!fm) throw new Error(`${fileName} : frontmatter manquant (--- title: "..." ---)`);
	const line = /^title:[ \t]*(.*?)[ \t]*$/m.exec(fm[1]);
	let title = line?.[1] ?? "";
	if (title.startsWith('"')) {
		try {
			title = JSON.parse(title);
		} catch {
			title = title.replace(/^"|"$/g, "");
		}
	} else if (title.startsWith("'")) {
		title = title.replace(/^'|'$/g, "");
	}
	title = title.trim();
	if (!title) throw new Error(`${fileName} : title obligatoire dans le frontmatter`);
	const markdown = text.slice(fm[0].length).trim();
	if (EMOJI.test(title) || EMOJI.test(markdown)) throw new Error(`${fileName} : emoji interdit dans une note`);
	return { version: name[1], title, markdown };
}

/** La plus recente d'abord. */
export function sortChangelogs<T extends { version: string }>(entries: T[]): T[] {
	return [...entries].sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Notes non vues. Un utilisateur qui n'a encore rien vu (nouveau compte, premiere
 * mise en service) ne recoit que la plus recente, pas tout l'historique : l'historique
 * reste lisible par « Precedent ».
 */
export function unseenCount(entries: { version: string }[], lastSeen: string | null): number {
	if (!entries.length) return 0;
	if (!lastSeen) return 1;
	return entries.filter((e) => compareVersions(e.version, lastSeen) > 0).length;
}

/** Libelle de date d'une version : « 6 novembre 2026 ». */
export function versionDateLabel(version: string): string {
	const [d] = split(version);
	const [y, m, day] = d.split("-").map(Number);
	const mois = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
	if (!y || !m || !day || m > 12) return version;
	return `${day === 1 ? "1er" : day} ${mois[m - 1]} ${y}`;
}
