import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGELOG_FILE, parseChangelog, sortChangelogs, type ChangelogEntry } from "./changelogs";

// ss2i (OI 10363) : lecture du dossier des notes de version. Le dossier est
// apps/web/changelogs, relatif au repertoire de travail : le serveur standalone fait
// chdir vers apps/web ; next.config.ts (outputFileTracingIncludes) y embarque les notes,
// sans rien ajouter au Dockerfile. CHANGELOGS_DIR le remplace (tests). Les commentaires
// turbopackIgnore ecartent l'avertissement « whole project traced » : le chemin est dynamique
// pour l'analyse, mais seul ce dossier est voulu dans la sortie.
export function changelogDir(): string {
	return process.env.CHANGELOGS_DIR || join(process.cwd(), "changelogs");
}

/** Notes de version, la plus recente d'abord. Une note mal formee est ignoree (le test la refuse avant le build). */
export function listChangelogs(): ChangelogEntry[] {
	const dir = changelogDir();
	if (!existsSync(/*turbopackIgnore: true*/ dir)) return [];
	const entries: ChangelogEntry[] = [];
	for (const file of readdirSync(/*turbopackIgnore: true*/ dir)) {
		if (!CHANGELOG_FILE.test(file)) continue;
		try {
			const path = join(/*turbopackIgnore: true*/ dir, file);
			entries.push(parseChangelog(file, readFileSync(/*turbopackIgnore: true*/ path, "utf8")));
		} catch (e) {
			console.error("[changelogs]", (e as Error).message);
		}
	}
	return sortChangelogs(entries);
}
