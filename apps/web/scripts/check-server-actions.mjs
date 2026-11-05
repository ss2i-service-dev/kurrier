#!/usr/bin/env node
// Guard against regressions in server actions.
//
// Next registers as an action callable by anyone EVERY function exported from a
// "use server" file, even if no client component imports it (checked in
// server-reference-manifest.json in production). This script lists those exports and
// fails (exit code 1) for each one that, before any sensitive operation (database without
// RLS, Redis queues, S3, fetch, vault), calls no check: isSignedIn, assert* from
// lib/authz.ts, rlsClient / rlsClientForWorkspace, verifyAndDecode, or a function of the
// same set of files that calls one (transitive computation by name).
// A server helper moves out of the "use server" file (module with import "server-only");
// a deliberately public action goes in ALLOWED below, with its reason.
//
// Usage (from the repository root): node apps/web/scripts/check-server-actions.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(path.join(webRoot, "package.json"))("typescript");

// Reviewed exports: public by nature, or with no data to protect.
const ALLOWED = {
	"lib/actions/auth.ts:login": "sign-in (password verified)",
	"lib/actions/auth.ts:signup": "sign-up (DISABLE_SIGNUP checked)",
	"lib/actions/auth.ts:signOut": "clears the caller's cookie",
	"lib/actions/auth.ts:getGravatarUrl": "local computation, no data",
	"lib/actions/appearance.ts:setThemeServer": "caller's appearance cookie",
	"lib/actions/appearance.ts:setModeServer": "caller's appearance cookie",
	"lib/actions/appearance.ts:setResolvedServer": "caller's appearance cookie",
	"lib/actions/calendar.ts:getRangeForCalendarView": "date computation, no data",
	"lib/actions/calendar.ts:eventsByDayWithAllDay": "computation on the supplied events, no data access",
	"lib/actions/calendar.ts:expandEventsForRange": "computation on the supplied events, no data access",
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
// Operations that must not precede the check.
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

// Top-level function bodies: function f() {}, const f = async () => {},
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

// Guarded functions, by name, up to the fixed point.
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
