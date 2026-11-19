// Heures toujours en 24 h, jamais AM/PM (Samuel le 12/11/2026 : « le PM, AM, ça me plaît pas du
// tout » ; le 19/11/2026 l'en-tête d'un mail affichait encore « Nov 13, 2026, 03:36 PM »).
// Garde sur le code de apps/web : tout appel toLocaleString / toLocaleTimeString /
// Intl.DateTimeFormat qui affiche une heure (option hour) doit soit être en fr-FR (24 h par
// défaut), soit forcer hourCycle "h23" ; hour12: true est refusé partout.
// Lancé par Dockerfile.web avant le build. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/heures-24h.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(__dirname, "..");
const dirs = ["app", "components", "lib", "hooks"].map((d) => join(root, d));

function walk(dir: string, out: string[] = []): string[] {
	let entries: string[] = [];
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const e of entries) {
		if (e === "node_modules" || e.startsWith(".")) continue;
		const p = join(dir, e);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (/\.(ts|tsx)$/.test(e)) out.push(p);
	}
	return out;
}

const problems: string[] = [];
const call = /(toLocaleString|toLocaleTimeString|Intl\.DateTimeFormat)\s*\(/g;
for (const file of dirs.flatMap((d) => walk(d))) {
	const src = readFileSync(file, "utf8");
	if (/hour12:\s*true/.test(src)) problems.push(`${relative(root, file)} : hour12: true`);
	for (const m of src.matchAll(call)) {
		// Les options tiennent dans les 300 caractères qui suivent l'appel.
		const window = src.slice(m.index!, m.index! + 300);
		const opts = window.slice(0, (window.indexOf("})") + 1) || window.length);
		if (!/\bhour\s*:/.test(opts)) continue;
		if (/["']fr-FR["']/.test(opts) || /hourCycle:\s*["']h23["']/.test(opts) || /hour12:\s*false/.test(opts)) continue;
		const line = src.slice(0, m.index!).split("\n").length;
		problems.push(`${relative(root, file)}:${line} : heure sans 24 h forcé`);
	}
}

if (problems.length) {
	console.log(`ECHEC heures en 24 h\n      ${problems.join("\n      ")}`);
	process.exit(1);
}
console.log("ok    toutes les heures affichées sont en 24 h");
