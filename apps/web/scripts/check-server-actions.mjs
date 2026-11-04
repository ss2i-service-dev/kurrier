#!/usr/bin/env node
// ss2i (controle d'acces) : garde-fou contre la regression des actions serveur.
//
// Next enregistre comme action appelable par n'importe qui TOUTE fonction exportee d'un
// fichier "use server", meme si aucun composant client ne l'importe (verifie dans
// server-reference-manifest.json en prod, 2026-11-04). Ce script liste ces exports et
// echoue (code 1) pour chacun qui, avant toute operation sensible (base sans RLS, files
// Redis, S3, fetch, coffre), n'appelle aucun controle : isSignedIn, assert* de
// lib/authz.ts, rlsClient / rlsClientForWorkspace, verifyAndDecode, ou une fonction du
// meme ensemble de fichiers qui en appelle un (calcul transitif par nom).
// Un helper serveur sort du fichier "use server" (module avec import "server-only") ;
// une action volontairement publique va dans ALLOWED ci-dessous, avec sa raison.
//
// Lancement (depuis la racine du depot) : node apps/web/scripts/check-server-actions.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(webRoot, "package.json"))("typescript");

// Exports revus : publics par nature, ou sans donnee a proteger.
const ALLOWED = {
	"lib/actions/auth.ts:login": "connexion (mot de passe verifie)",
	"lib/actions/auth.ts:signup": "inscription (DISABLE_SIGNUP verifie)",
	"lib/actions/auth.ts:signOut": "efface le cookie de l'appelant",
	"lib/actions/auth.ts:getGravatarUrl": "calcul local, sans donnee",
	"lib/actions/appearance.ts:setThemeServer": "cookie d'apparence de l'appelant",
	"lib/actions/appearance.ts:setModeServer": "cookie d'apparence de l'appelant",
	"lib/actions/appearance.ts:setResolvedServer": "cookie d'apparence de l'appelant",
	"lib/actions/calendar.ts:getRangeForCalendarView": "calcul de dates, sans donnee",
	"lib/actions/calendar.ts:eventsByDayWithAllDay": "calcul sur les evenements fournis, sans acces aux donnees",
	"lib/actions/calendar.ts:expandEventsForRange": "calcul sur les evenements fournis, sans acces aux donnees",
};

const GUARDS = new Set([
	"isSignedIn",
	"assertSignedIn",
	"assertWorkspace",
	"assertMailboxAccess",
	"assertThreadsInMailbox",
	"assertIdentityAccess",
	"assertMessageAccess",
	"assertOwnedS3Key",
	"rlsClient",
	"rlsClientForWorkspace",
	"verifyAndDecode",
]);
// Operations qui ne doivent pas preceder le controle.
const SINKS = [
	/\bdb\s*\.\s*(select|insert|update|delete|execute|transaction|selectDistinct)\b/,
	/\bgetRedis\s*\(/,
	/\bs3\s*\.\s*send\s*\(/,
	/\bgetSignedUrl\s*\(/,
	/(^|[^.\w])fetch\s*\(/,
	/\b(createSecret|updateSecret|getSecret|deleteSecret|deleteSecretAdmin|getSecretAdmin)\s*\(/,
	/\bpublicHttpRequest\s*\(/,
];

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === ".next" || e.name.startsWith(".")) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
	}
	return out;
}

const isUseServer = (sf) => {
	const first = sf.statements[0];
	return (
		first &&
		ts.isExpressionStatement(first) &&
		ts.isStringLiteral(first.expression) &&
		first.expression.text === "use server"
	);
};

// Corps des fonctions de premier niveau : function f() {}, const f = async () => {},
// const f = cache(async () => {}) ...
function topLevelFunctions(sf) {
	const fns = [];
	const isExported = (node) =>
		!!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
	for (const st of sf.statements) {
		if (ts.isFunctionDeclaration(st) && st.name && st.body) {
			fns.push({ name: st.name.text, exported: isExported(st), body: st.body, node: st });
		} else if (ts.isVariableStatement(st)) {
			for (const d of st.declarationList.declarations) {
				if (!ts.isIdentifier(d.name) || !d.initializer) continue;
				let fn = null;
				const visit = (n) => {
					if (fn) return;
					if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) fn = n;
					else ts.forEachChild(n, visit);
				};
				visit(d.initializer);
				if (fn) fns.push({ name: d.name.text, exported: isExported(st), body: fn.body, node: d });
			}
		}
	}
	return fns;
}

const files = walk(webRoot)
	.map((file) => ({ file, sf: ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true) }))
	.filter(({ sf }) => isUseServer(sf));

const all = files.flatMap(({ file, sf }) => topLevelFunctions(sf).map((f) => ({ ...f, file, sf, text: f.body.getText(sf) })));

// Fonctions gardees, par nom, jusqu'au point fixe.
const guarded = new Set(GUARDS);
const firstCall = (text, names) => {
	let best = -1;
	for (const n of names) {
		const m = new RegExp(`\\b${n}\\s*\\(`).exec(text);
		if (m && (best < 0 || m.index < best)) best = m.index;
	}
	return best;
};
const firstSink = (text) => {
	let best = -1;
	for (const re of SINKS) {
		const m = re.exec(text);
		if (m && (best < 0 || m.index < best)) best = m.index;
	}
	return best;
};
for (let changed = true; changed; ) {
	changed = false;
	for (const f of all) {
		if (guarded.has(f.name)) continue;
		const g = firstCall(f.text, guarded);
		const s = firstSink(f.text);
		if (g >= 0 && (s < 0 || g < s)) {
			guarded.add(f.name);
			changed = true;
		}
	}
}

const problems = [];
for (const f of all.filter((f) => f.exported)) {
	const rel = path.relative(webRoot, f.file);
	if (ALLOWED[`${rel}:${f.name}`]) continue;
	const g = firstCall(f.text, guarded);
	const s = firstSink(f.text);
	const line = f.sf.getLineAndCharacterOfPosition(f.node.getStart(f.sf)).line + 1;
	if (g < 0 && s >= 0) problems.push(`${rel}:${line} ${f.name}: sensitive operation without any access check`);
	else if (g >= 0 && s >= 0 && s < g) problems.push(`${rel}:${line} ${f.name}: sensitive operation before the access check`);
	else if (g < 0) problems.push(`${rel}:${line} ${f.name}: no access check (move it out of the "use server" file or allow it)`);
}

const exportedCount = all.filter((f) => f.exported).length;
if (problems.length) {
	console.log(problems.join("\n"));
	console.log(`\n${problems.length} unchecked server action(s) out of ${exportedCount} exported from ${files.length} "use server" files`);
	process.exit(1);
}
console.log(`OK: ${exportedCount} server actions exported from ${files.length} "use server" files, all checked`);
