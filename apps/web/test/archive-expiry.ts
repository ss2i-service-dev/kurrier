// Archiver avec une duree de vie (Samuel le 19/11/2026), cote web : l'action serveur transmet
// l'echeance au job mail:move (jamais posee avant le move), setThreadExpiry et la vue « Expire
// bientot » existent, la mention « Disparait le JJ/MM/AAAA » est affichee, le menu « Archiver
// pour... » n'a aucun sélecteur 12 h (regle : heures toujours en 24 h, ici date seule) et ne
// capte pas le raccourci `a` (ss2i-shortcuts.js vise data-k-action="archive" et
// data-ss2i-shortcut="selection-archive", jamais le nouveau bouton). Plan :
// docs/plans/archive-duree-de-vie.md, bloc 3. Aucune base, aucun reseau. Depuis la racine :
//   node_modules/.bin/tsx apps/web/test/archive-expiry.ts
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { archivedMessage, expiryMenuOptions, mailboxKindOf, pickerDate } from "../lib/archive-for";

let failed = 0;
function test(name: string, fn: () => void) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL ${name}\n${(e as Error).stack}`);
	}
}

const ROOT = join(__dirname, "..", "..", "..");
const WEB = join(ROOT, "apps", "web");
const src = (p: string) => readFileSync(join(WEB, p), "utf8");
// Source sans commentaires : un commentaire qui cite « AM/PM » ne doit pas compter.
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const NOW = new Date(2026, 10, 19, 10, 30, 0);

test("archivedMessage : date en JJ/MM/AAAA, pluriel, fils etoiles", () => {
	const d = new Date(2026, 11, 19);
	assert.equal(archivedMessage({ count: 1, expiresAt: d, starred: false }), "Archivé, disparaît le 19/12/2026");
	assert.equal(archivedMessage({ count: 3, expiresAt: d, starred: false }), "3 fils archivés, disparaissent le 19/12/2026");
	assert.equal(archivedMessage({ count: 1, expiresAt: d, starred: true }), "Archivé. Les fils étoilés n'expirent pas.");
	assert.equal(archivedMessage({ count: 2, expiresAt: d, starred: true }), "2 fils archivés. Les fils étoilés n'expirent pas.");
	assert.equal(archivedMessage({ count: 1, expiresAt: null, starred: false }), "Archivé");
	assert.equal(archivedMessage({ count: 4, expiresAt: null, starred: false }), "4 fils archivés");
});

test("expiryMenuOptions : les 5 durees, date JJ/MM/AAAA et ISO du debut du jour local", () => {
	const opts = expiryMenuOptions(NOW);
	assert.deepEqual(opts.map((o) => [o.id, o.label, o.date]), [
		["1m", "1 mois", "19/12/2026"],
		["3m", "3 mois", "19/02/2027"],
		["6m", "6 mois", "19/05/2027"],
		["1y", "1 an", "19/11/2027"],
		["2y", "2 ans", "19/11/2028"],
	]);
	assert.equal(opts[0].iso, new Date(2026, 11, 19).toISOString());
});

test("pickerDate : « AAAA-MM-JJ » (Mantine 8) ou Date -> debut du jour local, sinon null", () => {
	assert.equal(pickerDate("2026-12-25")?.getTime(), new Date(2026, 11, 25).getTime());
	assert.equal(pickerDate(new Date(2026, 11, 25, 15, 45))?.getTime(), new Date(2026, 11, 25).getTime());
	assert.equal(pickerDate(null), null);
	assert.equal(pickerDate(""), null);
	assert.equal(pickerDate("pas une date"), null);
});

test("archiveThread : 5e parametre expiresAt, valide par parseExpiry, ajoute aux donnees du job mail:move", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export const archiveThread");
	assert.ok(at > 0, "archiveThread introuvable");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body, /expiresAt\?:\s*string\s*\|\s*null/, "5e parametre optionnel");
	assert.match(body, /parseExpiry\(\s*expiresAt\s*,\s*new Date\(\)\s*\)/, "validation par parseExpiry");
	const job = body.slice(body.indexOf('"mail:move"'), body.indexOf("removeOnComplete", body.indexOf('"mail:move"')));
	assert.match(job, /op:\s*"archive"/);
	assert.match(job, /expiresAt/, "l'echeance part dans les donnees du job");
});

test("setThreadExpiry : une liste de fils en un appel, erreur claire si aucune ligne touchee (.returning)", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export async function setThreadExpiry");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body, /threadIds:\s*string\[\]/, "threadIds est une liste");
	assert.match(body, /inArray\(mailboxThreads\.threadId/, "un seul update pour la liste");
	assert.match(body, /\.returning\(/, "l'update rend les lignes touchees");
	assert.match(body, /length\s*===\s*0/, "aucune ligne touchee -> echec");
	assert.match(body, /ok:\s*false,\s*reason:[^\n]*(entre-temps|plus dans)/, "message clair");
});

test("setThreadExpiry : archive seulement, null annule, refus etoile ou ligne INBOX", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export async function setThreadExpiry");
	assert.ok(at > 0, "setThreadExpiry introuvable");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body, /rlsClient\(\)/);
	assert.match(body, /assertThreadsInMailbox\(/);
	assert.match(body, /kind\s*!==\s*"archive"/, "refus hors dossier archive");
	assert.match(body, /parseExpiry\(/);
	assert.match(body, /starred/, "refus d'un fil etoile");
	assert.match(body, /"inbox"/, "refus avec une ligne INBOX de la meme identite");
	assert.match(body, /ok:\s*false/);
});

test("fetchIdentityExpiringThreads : identite en parametre, dossier archive, tri croissant, 200 lignes, filtres cote serveur", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export const fetchIdentityExpiringThreads");
	assert.ok(at > 0, "fetchIdentityExpiringThreads introuvable");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body.slice(0, 200), /\(\s*identityPublicId:\s*string/, "identite en parametre");
	assert.match(body, /isNotNull\(mailboxThreads\.expiresAt\)/);
	assert.match(body, /eq\(mailboxThreads\.identityPublicId,\s*identityPublicId\)/, "filtre d'identite cote serveur");
	assert.match(body, /innerJoin\(mailboxes/, "jointure sur le dossier");
	assert.match(body, /eq\(mailboxes\.kind,\s*"archive"\)/, "dossier archive seulement");
	assert.match(body, /asc\(mailboxThreads\.expiresAt\)/);
	assert.match(body, /\.limit\(200\)/);
});

test("fetchExpiringCounts : compteur de la barre laterale par identite, dossier archive, calcule cote serveur", () => {
	const s = code("lib/actions/mailbox.ts");
	const at = s.indexOf("export const fetchExpiringCounts");
	assert.ok(at > 0, "fetchExpiringCounts introuvable");
	const body = s.slice(at, s.indexOf("\nexport ", at + 10));
	assert.match(body, /isNotNull\(mailboxThreads\.expiresAt\)/);
	assert.match(body, /eq\(mailboxes\.kind,\s*"archive"\)/);
	assert.match(body, /groupBy\(mailboxThreads\.identityId\)/);
});

test("mail-store : mailActions.archive passe expiresAt a archiveThread", () => {
	const s = code("components/k/mail-store.ts");
	const at = s.indexOf("archive(threadIds");
	const body = s.slice(at, s.indexOf("trash(threadIds", at));
	assert.match(body, /expiresAt/);
	assert.match(body, /archiveThread\(list,\s*mailboxId,\s*smtp,\s*false,\s*expiresAt\)/);
});

test("thread-row : mention « Disparait le » (formatExpiry, text-k-warn) quand expiresAt est non nul", () => {
	const s = code("components/k/thread-row.tsx");
	assert.match(s, /Disparaît le/);
	assert.match(s, /formatExpiry\(/);
	assert.match(s, /item\.expiresAt/);
	assert.match(s, /text-k-warn/);
});

test("vue du mail : mention et bouton « Garder » (setThreadExpiry a null)", () => {
	const s = code("components/k/expiry-notice.tsx");
	assert.match(s, /Disparaît le/);
	assert.match(s, /Garder/);
	assert.match(s, /setThreadExpiry\(\{[^}]*expiresAt:\s*null/);
	assert.match(code("components/k/thread-page.tsx"), /KExpiryNotice/);
});

test("archive-for.tsx : aucun selecteur 12 h, aucun AM/PM, date seule", () => {
	const s = code("components/k/archive-for.tsx");
	assert.ok(!/format:\s*"12h"/.test(s), 'format: "12h"');
	assert.ok(!/hh:mm A/.test(s), "hh:mm A");
	assert.ok(!/\b(AM|PM)\b/.test(s), "mot isole AM ou PM");
	assert.ok(!/DateTimePicker|TimeInput|TimePicker/.test(s), "aucun selecteur d'heure");
	assert.match(s, /DatePickerInput/);
	assert.match(s, /valueFormat="DD\/MM\/YYYY"/);
	assert.match(s, /minDate=/);
	assert.match(s, /EXPIRY_PRESETS|expiryMenuOptions/);
});

test("archive-for.tsx : une selection en Archive = un seul appel serveur", () => {
	const s = code("components/k/archive-for.tsx");
	assert.match(s, /setThreadExpiry\(\{\s*threadIds:\s*ids\b/, "setThreadExpiry({ threadIds: ids, ... })");
	assert.ok(!/ids\.map\([^)]*setThreadExpiry/.test(s), "plus un appel par fil");
	assert.ok(!/Promise\.all/.test(s), "plus de Promise.all");
});

test("archive-for.tsx : ne capte pas le raccourci `a` ; bouton de la barre : infobulle title, aucun texte", () => {
	const s = code("components/k/archive-for.tsx");
	assert.ok(!/data-k-action|action=["{]\s*"?archive/.test(s), 'data-k-action="archive"');
	assert.ok(!/data-ss2i-shortcut="selection-archive"/.test(s), "selection-archive");
	assert.ok(!/<KIconButton\b[^>]*\btitle=/.test(s), "le KIconButton a deja son infobulle (label)");
	// Le repli de ss2i-shortcuts.js lit textContent (« Archive... ») : le bouton nu ne contient que l'icone.
	const bulk = /<button\b[^>]*aria-label=\{label\}[^>]*>([\s\S]*?)<\/button>/.exec(s);
	assert.ok(bulk, "bouton nu de la barre de selection introuvable");
	assert.match(bulk![0], /\btitle=\{label\}/, "title={label}");
	assert.equal(bulk![1].trim(), "{icon}", "aucun texte dans le bouton : textContent vide");
	const shortcuts = readFileSync(join(WEB, "public", "ss2i-shortcuts.js"), "utf8");
	assert.match(shortcuts, /b\.textContent\.trim\(\)\.startsWith\(libelle\)/, "le repli par textContent existe toujours (et ne lit pas title)");
	assert.ok(!/getAttribute\(["']title["']\)|\[title[\]=*^$~|]/.test(shortcuts), "ss2i-shortcuts.js ne vise jamais par title");
});

test("archive-for : place a cote de chaque « Archiver » (selection, ligne, barre du mail ouvert)", () => {
	for (const f of ["components/k/list-header.tsx", "components/k/thread-row.tsx", "components/k/thread-toolbar.tsx"]) {
		assert.match(code(f), /<KArchiveFor\b/, f);
	}
});

test("raccourci `a` et catalogue inchanges : aucun nouveau raccourci", () => {
	const s = code("components/k/shortcuts-catalog.ts");
	assert.ok(!/expir|archive-for|archiver pour/i.test(s), "le catalogue ne parle pas d'expiration");
});

test("vue « Expire bientot » : page expiring et lien de la barre laterale sous « Reportes »", () => {
	const page = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]/expiring/page.tsx";
	assert.ok(existsSync(join(WEB, page)), page);
	assert.match(code(page), /fetchIdentityExpiringThreads\(\s*identityPublicId\s*\)/);
	const nav = code("components/k/sidebar-nav.tsx");
	assert.match(nav, /\/expiring`/);
	assert.match(nav, /Expire bientôt/);
	assert.ok(nav.indexOf("Reportés") < nav.indexOf("Expire bientôt"), "« Expire bientôt » sous « Reportés »");
	assert.match(code("components/k/sidebar-nav-wrapper.tsx"), /fetchExpiringCounts\(\)/);
	assert.ok(!/expiringThreads\.filter|identityId === identity\.id/.test(code("components/k/sidebar-nav.tsx").slice(nav.indexOf("expiringCount") - 200, nav.indexOf("expiringCount") + 400)), "plus de filtre d'identite cote client");
});

test("listes : les requetes de liste rendent la ligne entiere (expiresAt compris)", () => {
	// Aucune requete de liste n'enumere ses colonnes : select({ thread: mailboxThreads }) rend expiresAt.
	for (const f of ["lib/actions/mailbox.ts", "lib/actions/k-threads.ts", "lib/actions/thread-clients.ts"]) {
		assert.match(code(f), /select\(\{\s*thread:\s*mailboxThreads\s*\}\)|\.select\(\)\s*\.from\(mailboxThreads\)/, f);
	}
});

test("note Nouveautes : premiere note libre du 19/11, durees, annulations, Expire bientot, Corbeille", () => {
	const dir = join(WEB, "changelogs");
	const note = ["2026-11-19-5.md", "2026-11-19-6.md", "2026-11-19-7.md"].map((f) => join(dir, f)).find((f) => existsSync(f) && /Archiver pour/.test(readFileSync(f, "utf8")));
	assert.ok(note, "aucune note 2026-11-19-N.md sur « Archiver pour »");
	const s = readFileSync(note!, "utf8");
	assert.match(s, /^---\ntitle: ".+"\n---\n/);
	assert.match(s, /## Nouveautés/);
	assert.match(s, /1 mois/);
	assert.match(s, /Expire bientôt/);
	assert.match(s, /[Cc]orbeille/);
	assert.match(s, /étoile/);
	assert.ok(!/À vérifier/.test(s), "aucun « À vérifier » a l'utilisateur");
	assert.match(s, /vide automatiquement/, "la Corbeille est videe automatiquement apres un delai");
	assert.match(s, /Un fil étoilé n'expire jamais/);
});

// Interface CLASSIQUE (option par utilisateur, components/k/ui-context.tsx) : Samuel l'utilise, et
// KArchiveFor n'etait rendu que par les composants k/. Memes composants, memes actions serveur.
const PAGES = "app/[locale]/w/[wPublicId]/dashboard/(unified)/(mail)/mail/[identityPublicId]";
const THREAD_PAGES = [
	`${PAGES}/[mailboxSlug]/threads/[threadId]/page.tsx`,
	`${PAGES}/[mailboxSlug]/@thread/(.)threads/[threadId]/page.tsx`,
];

test("classique, ligne de la liste : « Archiver pour… » au survol, entre Archive et Delete, Archive intact", () => {
	const s = code("components/mailbox/default/webmail-list-item.tsx");
	assert.match(s, /import KArchiveFor from "@\/components\/k\/archive-for"/);
	const at = s.indexOf("<KArchiveFor");
	assert.ok(at > 0, "<KArchiveFor rendu par la ligne classique");
	assert.ok(s.indexOf('title="Archive"') < at && at < s.indexOf('title="Delete"'), "entre Archive et Delete");
	const tag = s.slice(at, s.indexOf("/>", at));
	assert.match(tag, /mailboxId=\{activeMailbox\.id\}/);
	assert.match(tag, /mailboxKind=\{activeMailbox\.kind\}/);
	assert.match(tag, /smtp=\{!!mailboxSync\}/);
	assert.match(tag, /threadIds=\{\(\) => \[String\(mailboxThreadItem\.threadId\)\]\}/);
	assert.match(tag, /starred=\{\(\) => !!mailboxThreadItem\.starred\}/);
	assert.match(tag, /bulkClassName=/, "bouton nu, icone seule, comme ses voisins (aucun style k-)");
	assert.match(s.slice(Math.max(0, at - 120), at), /!sendPending/, "jamais sur un envoi en attente");
	assert.match(s, /archiveThread\(id, activeMailbox\.id, !!mailboxSync, true\)/, "Archive inchange");
});

test("classique, ligne : mention « Disparait le JJ/MM/AAAA » (orange) quand expiresAt est pose, desktop et mobile", () => {
	for (const f of ["webmail-list-item.tsx", "webmail-list-item-mobile.tsx"]) {
		const s = code(`components/mailbox/default/${f}`);
		assert.match(s, /<ExpiryMention\b[^>]*expiresAt=\{mailboxThreadItem\.expiresAt\}/, f);
		assert.match(s, /import ExpiryMention from "@\/components\/mailbox\/default\/expiry-mention"/, f);
	}
	const m = code("components/mailbox/default/expiry-mention.tsx");
	assert.match(m, /formatExpiry\(/);
	assert.match(m, /Disparaît le/);
	assert.match(m, /text-orange-/, "couleur Tailwind standard : les jetons k- n'existent pas en classique");
	assert.ok(!/\bk-[a-z]/.test(m.replace(/\bk-focus\b/g, "")), "aucun jeton k-");
	assert.ok(!/!\s*expiresAt|expiresAt\s*\?/.test(m) || /return null/.test(m), "rien sans echeance");
});

test("classique, barre de selection : « Archiver pour… » apres Archive (data-ss2i-shortcut intact), selection videe avant", () => {
	const s = code("components/mailbox/default/mail-list-header.tsx");
	assert.match(s, /import KArchiveFor from "@\/components\/k\/archive-for"/);
	const at = s.indexOf("<KArchiveFor");
	assert.ok(at > 0, "<KArchiveFor rendu par l'en-tete classique");
	assert.ok(s.indexOf('data-ss2i-shortcut="selection-archive"') < at, "apres le bouton Archive");
	const tag = s.slice(at, s.indexOf("/>", at));
	assert.match(tag, /mailboxId=\{String\(mailboxIdRef\.current\)\}/);
	assert.match(tag, /mailboxKind=\{String\(mailboxKind\.current\)\}/);
	assert.match(tag, /threadIds=\{\(\) => Array\.from\(state\?\.selectedThreadIds \?\? \[\]\)\.map\(String\)\}/);
	assert.match(tag, /starred=\{/);
	assert.match(tag, /before=\{clearSelection\}/);
	assert.match(tag, /bulkClassName=/);
	assert.match(s, /onClick=\{archiveThreads\}/, "Archive inchange");
});

test("classique, mail ouvert : « Archiver pour… » a cote d'Archive (a), icone seule, Archive et ses libelles intacts", () => {
	const s = code("components/mailbox/default/email-renderer.tsx");
	assert.match(s, /import KArchiveFor from "@\/components\/k\/archive-for"/);
	const at = s.indexOf("<KArchiveFor");
	assert.ok(at > 0, "<KArchiveFor rendu par la barre du mail classique");
	assert.ok(s.indexOf('<Tooltip label="Archive (a)"') < at && at < s.indexOf('label="Mark as unread and back to the list"'), "apres Archive (a), avant Mark as unread");
	const tag = s.slice(at, s.indexOf("/>", at));
	assert.match(tag, /mailboxId=\{activeMailboxId\}/);
	assert.match(tag, /mailboxKind=\{mailboxKindOf\(identityMailboxes, activeMailboxId\)\}/);
	assert.match(tag, /smtp=\{markSmtp\}/);
	assert.match(tag, /threadIds=\{\(\) => \[String\(threadId\)\]\}/);
	assert.match(tag, /starred=\{\(\) => !!starred\}/);
	assert.match(tag, /before=\{leaveThread\}/, "retour a la liste comme Archive");
	assert.match(tag, /renderTrigger=/, "ActionIcon Mantine comme ses voisins");
	assert.match(s, /aria-label="Archive" onClick=\{archiveMessage\}/, "Archive inchange");
	assert.match(s, /\n\s*Archive\n\s*<\/Button>/, "bouton texte « Archive » du bas inchange (repli textContent de a)");
});

test("classique, vue du mail : encart « Disparait le » avec « Garder » (KExpiryNotice) dans les deux pages du fil, starred transmis", () => {
	for (const f of THREAD_PAGES) {
		const s = code(f);
		assert.match(s, /fetchThreadExpiry\(threadId, activeMailbox\.id\)/, f);
		assert.match(s, /<KExpiryNotice\b[^>]*threadId=\{threadId\}[^>]*mailboxId=\{activeMailbox\.id\}[^>]*expiresAt=\{expiry\.expiresAt\}/, f);
		assert.match(s, /expiry\.expiresAt && /, "seulement avec une echeance");
		assert.match(s, /starred=\{expiry\.starred\}/, `${f} : starred vers ThreadItem`);
	}
	assert.match(code("components/mailbox/default/thread-item.tsx"), /starred\??:\s*boolean/);
	assert.match(code("components/mailbox/default/thread-item.tsx"), /starred=\{starred\}/);
});

test("KExpiryNotice et KArchiveFor : habillage classique sans jeton k- (--k-* n'existent que dans la nouvelle interface)", () => {
	const n = code("components/k/expiry-notice.tsx");
	assert.match(n, /useNouvelle\(\)/);
	assert.match(n, /bg-orange-50/);
	assert.match(n, /bg-k-warn-soft/, "nouvelle interface inchangee");
	assert.match(n, /className\??:\s*string/, "marges du conteneur au choix de l'appelant");
	const a = code("components/k/archive-for.tsx");
	assert.match(a, /useNouvelle\(\)/);
	assert.match(a, /text-muted-foreground/, "date du menu en classique");
	assert.match(a, /renderTrigger\??:/);
	// Aucun libelle commencant par « Archive » dans un bouton visible : le repli textContent de `a` reste sur Archive.
	assert.ok(!/<ActionIcon[^>]*>\s*Archive/.test(a));
});

test("mailboxKindOf : genre du dossier actif parmi les dossiers des identites, vide si inconnu", () => {
	const boxes = [
		{ mailboxes: [{ id: "a1", kind: "inbox" }, { id: "a2", kind: "archive" }] },
		{ mailboxes: [{ id: "b1", kind: "trash" }] },
	] as any;
	assert.equal(mailboxKindOf(boxes, "a2"), "archive");
	assert.equal(mailboxKindOf(boxes, "b1"), "trash");
	assert.equal(mailboxKindOf(boxes, "zz"), "");
	assert.equal(mailboxKindOf(null, "a1"), "");
});

test("classique, barre laterale : « Expire bientot » sous Snoozed, compteur serveur, page expiring classique", () => {
	const l = code("components/dashboard/identity-mailboxes-list.tsx");
	assert.match(l, /expiringCountsPromise:\s*Promise<Record<string, number>>/);
	assert.match(l, /use\(expiringCountsPromise\)\[identity\.id\] \?\? 0/);
	assert.match(l, /\/expiring`/);
	assert.match(l, /Expire bientôt/);
	assert.match(l, /currentSlug === "expiring"/);
	assert.ok(l.indexOf("Snoozed (") < l.indexOf("Expire bientôt"), "sous Snoozed");
	assert.match(l, /expiringCountsPromise=\{expiringCountsPromise\}/, "passe au rendu par identite");
	assert.match(code("components/dashboard/workspaces/identity-mailboxes-list-wrapper.tsx"), /expiringCountsPromise=\{fetchExpiringCounts\(\)\}/);
	const p = code(`${PAGES}/expiring/page.tsx`);
	assert.match(p, /async function ClassicExpiringPage/);
	assert.match(p, /isNouvelleInterface\(\)\) \? <NouvelleExpiringPage[^:]*: <ClassicExpiringPage/);
	assert.ok(/<WebmailListLabelSearch/.test(p.slice(p.indexOf("ClassicExpiringPage"), p.indexOf("NouvelleExpiringPage"))), "liste classique");
});

test("note Nouveautes : mentionne l'interface classique", () => {
	const s = readFileSync(join(WEB, "changelogs", "2026-11-19-5.md"), "utf8");
	assert.match(s, /interface classique/i);
});

if (failed) {
	console.error(`${failed} echec(s)`);
	process.exit(1);
}
