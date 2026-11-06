// Nouveautes (OI 10363). Samuel le 06/11/2026 : « un splash screen qui donne les nouveautes a
// chaque fois qu'on fait une mise a jour. Comme ca, le reste de l'equipe il est au courant
// qu'on a mis en place telle ou telle chose. » Modele : Docator (commit 9931601).
// Ce test est lance par Dockerfile.web avant le build : rouge = pas d'image.
//   1) notes : nom AAAA-MM-JJ.md, tri chronologique (-2 apres le jour meme), frontmatter avec
//      titre obligatoire, aucun emoji, lecture du dossier qui ignore une note mal formee ;
//   2) non vues : un nouvel utilisateur ne recoit que la plus recente, pas tout l'historique ;
//   3) rendu markdown : titres, listes, gras, liens sans javascript:, jamais de HTML injecte ;
//   4) les notes du depot : toutes lisibles, bien nommees, rendues sans reste de syntaxe ;
//   5) cablage : bouton dans les DEUX interfaces, fournisseur dans le layout du tableau de bord,
//      derniere version vue par utilisateur cote serveur sans nouvelle migration, notes
//      embarquees dans la sortie standalone.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/changelogs.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CHANGELOG_FILE,
	compareVersions,
	parseChangelog,
	sortChangelogs,
	unseenCount,
	versionDateLabel,
} from "../lib/changelogs";
import { parseInline, parseMarkdown, safeHref } from "../lib/changelog-markdown";
import { listChangelogs } from "../lib/changelogs-files";

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

const note = (title: string, body = "## Une\n\n- point") => `---\ntitle: "${title}"\n---\n\n${body}\n`;

// 1) notes
test("tri chronologique, la plus recente d'abord, -2 apres le jour meme et -10 apres -2", () => {
	const v = ["2026-11-06", "2026-11-06-10", "2026-12-01", "2026-11-06-2", "2026-10-30"];
	assert.deepEqual(
		sortChangelogs(v.map((version) => ({ version }))).map((e) => e.version),
		["2026-12-01", "2026-11-06-10", "2026-11-06-2", "2026-11-06", "2026-10-30"],
	);
	assert.ok(compareVersions("2026-11-06", "2026-11-06-2") < 0);
	assert.ok(compareVersions("2026-11-06-2", "2026-11-06-10") < 0);
});

test("nom de fichier : AAAA-MM-JJ.md avec suffixe facultatif, rien d'autre", () => {
	for (const ok of ["2026-11-06.md", "2026-11-06-2.md"]) assert.ok(CHANGELOG_FILE.test(ok), ok);
	for (const ko of ["README.md", "2026-11-6.md", "nouveautes.md", "2026-11-06.txt", "2026-11-06-.md"]) {
		assert.ok(!CHANGELOG_FILE.test(ko), ko);
	}
	assert.throws(() => parseChangelog("README.md", note("x")), /nom attendu/);
});

test("la version est le nom du fichier, le titre vient du frontmatter", () => {
	const e = parseChangelog("2026-11-06-2.md", note("Agenda et clients"));
	assert.equal(e.version, "2026-11-06-2");
	assert.equal(e.title, "Agenda et clients");
	assert.ok(e.markdown.startsWith("## Une"));
	assert.equal(parseChangelog("2026-11-06.md", "---\ntitle: Sans guillemets\n---\ncorps").title, "Sans guillemets");
	assert.equal(parseChangelog("2026-11-06.md", "---\r\ntitle: 'Simples'\r\n---\r\ncorps").title, "Simples");
});

test("frontmatter sans titre, titre vide ou frontmatter absent : refuse", () => {
	assert.throws(() => parseChangelog("2026-11-06.md", "---\nauteur: x\n---\n\ncorps"), /title obligatoire/);
	assert.throws(() => parseChangelog("2026-11-06.md", '---\ntitle: ""\n---\n\ncorps'), /title obligatoire/);
	assert.throws(() => parseChangelog("2026-11-06.md", "## Juste un corps"), /frontmatter manquant/);
});

test("emoji refuse dans le titre comme dans le corps, accents et fleches ASCII acceptes", () => {
	assert.throws(() => parseChangelog("2026-11-06.md", note("Nouveau \u{1F680}")), /emoji/);
	assert.throws(() => parseChangelog("2026-11-06.md", note("Titre", "- fait ✅")), /emoji/);
	assert.throws(() => parseChangelog("2026-11-06.md", note("Titre", "- alerte ⚠️")), /emoji/);
	assert.doesNotThrow(() => parseChangelog("2026-11-06.md", note("Été à l'agenda", "- Paramètres > Règles -> œuvre")));
});

test("lecture du dossier : notes triees, README et note mal formee ignores", () => {
	const dir = mkdtempSync(join(tmpdir(), "changelogs-"));
	const prev = process.env.CHANGELOGS_DIR;
	const log = console.error;
	try {
		writeFileSync(join(dir, "2026-11-06.md"), note("Premiere"));
		writeFileSync(join(dir, "2026-11-20.md"), note("Seconde"));
		writeFileSync(join(dir, "2026-11-25.md"), "---\nauteur: x\n---\nsans titre");
		writeFileSync(join(dir, "README.md"), "pas une note");
		process.env.CHANGELOGS_DIR = dir;
		console.error = () => {};
		assert.deepEqual(
			listChangelogs().map((e) => e.version),
			["2026-11-20", "2026-11-06"],
		);
		process.env.CHANGELOGS_DIR = join(dir, "absent");
		assert.deepEqual(listChangelogs(), []);
	} finally {
		console.error = log;
		if (prev === undefined) delete process.env.CHANGELOGS_DIR;
		else process.env.CHANGELOGS_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

// 2) non vues
test("notes non vues : rien, a jour, en retard, et nouveau compte = la plus recente seulement", () => {
	const entries = ["2026-11-20", "2026-11-12", "2026-11-06", "2026-10-30"].map((version) => ({ version }));
	assert.equal(unseenCount([], null), 0);
	assert.equal(unseenCount([], "2026-11-06"), 0);
	assert.equal(unseenCount(entries, "2026-11-20"), 0);
	assert.equal(unseenCount(entries, "2026-11-06"), 2);
	assert.equal(unseenCount(entries, "2026-10-01"), 4);
	// Nouvel utilisateur : jamais tout l'historique d'un coup.
	assert.equal(unseenCount(entries, null), 1);
	// Une version vue qui n'existe plus (note retiree) ne compte rien de plus.
	assert.equal(unseenCount(entries, "2026-12-31"), 0);
	// Le deuxieme jeu du meme jour est une nouvelle note.
	assert.equal(unseenCount([{ version: "2026-11-06-2" }, { version: "2026-11-06" }], "2026-11-06"), 1);
});

test("libelle de date lu dans le nom de version", () => {
	assert.equal(versionDateLabel("2026-11-06"), "6 novembre 2026");
	assert.equal(versionDateLabel("2026-12-01-2"), "1er décembre 2026");
	assert.equal(versionDateLabel("n'importe quoi"), "n'importe quoi");
});

// 3) rendu markdown
test("markdown : titres, paragraphes, listes a puces et numerotees, citation, filet", () => {
	const b = parseMarkdown("Intro **gras** et *italique* avec `code`.\n\n## Agenda\n\n- un\n  suite\n- deux\n\n1. premier\n2. second\n\n> cite\n\n---\n\nfin");
	assert.deepEqual(
		b.map((x) => x.t),
		["p", "heading", "list", "list", "quote", "hr", "p"],
	);
	const list = b[2] as Extract<(typeof b)[number], { t: "list" }>;
	assert.equal(list.ordered, false);
	assert.equal(list.items.length, 2);
	assert.deepEqual(list.items[0], [{ t: "text", v: "un suite" }]);
	assert.equal((b[3] as any).ordered, true);
	assert.deepEqual(
		(b[0] as any).c.map((n: any) => n.t),
		["text", "strong", "text", "em", "text", "code", "text"],
	);
});

test("markdown : liens http, mailto et du site seulement, jamais javascript: ni data:", () => {
	for (const ok of ["https://mail.ss2i.ca", "http://x.fr/a?b=1", "mailto:a@b.fr", "/fr/w/abc", "#haut"]) assert.ok(safeHref(ok), ok);
	for (const ko of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "//evil.example", "vbscript:x"]) assert.ok(!safeHref(ko), ko);
	assert.deepEqual(parseInline("[ok](https://a.fr)"), [{ t: "link", href: "https://a.fr", c: [{ t: "text", v: "ok" }] }]);
	assert.deepEqual(parseInline("[piege](javascript:alert)"), [{ t: "text", v: "piege" }]);
});

test("markdown : le HTML d'une note reste du texte", () => {
	const [p] = parseMarkdown("<script>alert(1)</script> et <b>gras</b>");
	assert.deepEqual((p as any).c, [{ t: "text", v: "<script>alert(1)</script> et <b>gras</b>" }]);
});

// 4) notes du depot
const dir = join(__dirname, "../changelogs");
const files = readdirSync(dir);

test("notes du depot : chaque fichier est une note bien nommee, bien formee, sans emoji", () => {
	assert.ok(files.length > 0, "aucune note dans apps/web/changelogs");
	for (const f of files) {
		assert.ok(CHANGELOG_FILE.test(f), `${f} : nom attendu AAAA-MM-JJ.md`);
		parseChangelog(f, readFileSync(join(dir, f), "utf8"));
	}
});

test("notes du depot : rendues sans reste de syntaxe markdown, au plus 15 points par note", () => {
	for (const f of files) {
		const { markdown } = parseChangelog(f, readFileSync(join(dir, f), "utf8"));
		const blocks = parseMarkdown(markdown);
		const text = JSON.stringify(blocks);
		assert.ok(!/\*\*|(^|\\n)#{1,4} |\]\(/.test(text), `${f} : syntaxe markdown non rendue`);
		assert.ok(blocks.some((b) => b.t === "heading"), `${f} : au moins un titre de theme`);
		const points = blocks.reduce((n, b) => n + (b.t === "list" ? b.items.length : 0), 0);
		assert.ok(points > 0 && points <= 15, `${f} : ${points} points`);
	}
});

// 5) cablage
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

test("bouton Nouveautes dans les DEUX interfaces et fournisseur dans le layout du tableau de bord", () => {
	assert.match(src("components/ui/dashboards/unified/default/app-sidebar.tsx"), /<WhatsNewButton variant="classic"/);
	assert.match(src("components/k/mail-shell.tsx"), /<WhatsNewButton variant="k"/);
	const layout = src("app/[locale]/w/[wPublicId]/dashboard/(unified)/layout.tsx");
	assert.match(layout, /fetchChangelogs\(\)/);
	assert.match(layout, /<WhatsNewProvider entries=\{entries\} lastSeen=\{lastSeen\}>/);
});

test("toute barre laterale (classique ou Outlook) vit sous ce layout", () => {
	const walk = (d: string): string[] =>
		readdirSync(d, { withFileTypes: true }).flatMap((e) => {
			const p = join(d, e.name);
			return e.isDirectory() ? walk(p) : /\.tsx?$/.test(e.name) ? [p] : [];
		});
	const appDir = join(__dirname, "../app");
	const hors = walk(appDir).filter((f) => {
		const s = readFileSync(f, "utf8");
		return /<AppSidebar\b|<KMailShell\b|<KAppShell\b/.test(s) && !f.includes("/dashboard/(unified)/");
	});
	assert.deepEqual(hors, []);
});

test("modale : ouverture automatique, marquage vu des l'ouverture, Precedent et Suivant", () => {
	const s = src("components/common/whats-new.tsx");
	assert.match(s, /autoOpened\.current/);
	assert.match(s, /markChangelogSeen\(newest\)/);
	assert.match(s, /Précédent/);
	assert.match(s, /Suivant/);
});

test("derniere version vue : par utilisateur, cote serveur, dans workspaces.meta, sans nouvelle migration", () => {
	const a = src("lib/actions/changelogs.ts");
	assert.match(a, /^"use server";/);
	assert.match(a, /ss2iChangelogSeen/);
	assert.match(a, /compareVersions\(version, current\) <= 0/); // on ne recule jamais
	assert.match(a, /listChangelogs\(\)\.some\(\(e\) => e\.version === version\)/); // version inconnue refusee
	// db/ n'est pas dans le contexte de construction de l'image : controle fait seulement dans le depot.
	const migrationsDir = join(__dirname, "../../../db/init/migrations");
	if (existsSync(migrationsDir)) {
		const migrations = readdirSync(migrationsDir);
		assert.ok(!migrations.some((m) => /ss2i_007/.test(m)), "pas de migration pour les nouveautes");
	}
});

test("notes embarquees dans la sortie standalone (outputFileTracingIncludes)", () => {
	assert.match(src("next.config.ts"), /outputFileTracingIncludes:\s*\{\s*"\/\*\*":\s*\["\.\/changelogs\/\*\*\/\*"\]/);
});

if (failures) {
	console.log(`\n${failures} echec(s)`);
	process.exit(1);
}
console.log("\ntout est vert");
