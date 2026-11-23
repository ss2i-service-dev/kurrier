// Agenda : ouverture lente (Jean-Baptiste le 23/11/2026, « super lent a charger les events »).
// Mesure sur hlm : evenements d'une semaine en 0,1 a 0,5 s par agenda, mais droits sur l'agenda
// d'un collegue (calendarPermissions) en 18 a 20 s a froid, gardes 30 min en memoire seulement
// et perdus a chaque redemarrage ; et une seule lecture pour tous les agendas, qui attendait le
// plus lent. Droits gardes dans Redis et relus en arriere-plan (lib/calendar-role-cache.ts),
// une lecture par groupe d'agendas (sourceGroups).
// Sans base ni Redis. Depuis la racine : node_modules/.bin/tsx apps/web/test/agenda-speed.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.REDIS_HOST = "127.0.0.1";
process.env.REDIS_PORT = "1"; // aucun Redis : repli sur la memoire du processus

let failures = 0;
const test = async (label: string, fn: () => Promise<void> | void) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.log(`ECHEC ${label}\n      ${err?.message ?? err}`);
	}
};
const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

(async () => {
	const { cachedRole, forgetRole, roleDecision, ROLE_FRESH_MS, ROLE_MAX_STALE_MS } = await import("../lib/calendar-role-cache");
	const realNow = Date.now;
	let offset = 0;
	Date.now = () => realNow() + offset;
	const counter = () => {
		const c = { n: 0, role: "reviewer", read: async () => (c.n++, c.role) };
		return c;
	};

	await test("roleDecision : frais 30 min, puis a relire en arriere-plan, oublie apres 7 jours", () => {
		const now = 1_000_000_000_000;
		assert.equal(roleDecision(null, now), "miss");
		assert.equal(roleDecision({ at: now - 1000, role: "reviewer" }, now), "fresh");
		assert.equal(roleDecision({ at: now - ROLE_FRESH_MS - 1, role: "reviewer" }, now), "stale");
		assert.equal(roleDecision({ at: now - ROLE_MAX_STALE_MS, role: "reviewer" }, now), "miss");
		assert.equal(roleDecision({ at: now + 60_000, role: "reviewer" }, now), "miss", "date dans le futur");
	});

	await test("premier acces : Graph lu une fois, meme pour des lectures simultanees", async () => {
		const c = counter();
		const roles = await Promise.all([cachedRole("a>b", c.read), cachedRole("a>b", c.read), cachedRole("a>b", c.read)]);
		assert.deepEqual(roles, ["reviewer", "reviewer", "reviewer"]);
		assert.equal(c.n, 1);
		await cachedRole("a>b", c.read);
		assert.equal(c.n, 1, "droit frais : pas de nouvelle lecture");
	});

	await test("droit de plus de 30 min : servi tout de suite, relu en arriere-plan", async () => {
		const c = counter();
		await cachedRole("a>c", c.read);
		offset = ROLE_FRESH_MS + 1000;
		c.role = "none"; // partage retire dans Outlook
		let resolved = false;
		const slow = async () => {
			await new Promise((r) => setTimeout(r, 50));
			resolved = true;
			return c.read();
		};
		const first = await cachedRole("a>c", slow);
		assert.equal(first, "reviewer", "ancien droit servi sans attendre Graph");
		assert.equal(resolved, false);
		await new Promise((r) => setTimeout(r, 80));
		assert.equal(await cachedRole("a>c", c.read), "none", "la relecture suivante voit le retrait");
		offset = 0;
	});

	await test("relecture en echec : le dernier droit connu reste", async () => {
		const c = counter();
		await cachedRole("a>d", c.read);
		offset = ROLE_FRESH_MS + 1000;
		const role = await cachedRole("a>d", async () => {
			throw new Error("Graph 503");
		});
		assert.equal(role, "reviewer");
		await new Promise((r) => setTimeout(r, 10));
		offset = 0;
	});

	await test("forgetRole : l'ajout explicite d'un collegue relit Graph", async () => {
		const c = counter();
		await cachedRole("a>e", c.read);
		await forgetRole("a>e");
		await cachedRole("a>e", c.read);
		assert.equal(c.n, 2);
	});

	await test("branchements : roleFor passe par le cache, lectures par groupe d'agendas", () => {
		const actions = src("lib/actions/outlook-calendar.ts");
		assert.match(actions, /cachedRole<CalendarRole>\(`\$\{me\}>\$\{owner\}`/);
		assert.match(actions, /await forgetRole\(`\$\{me\}>\$\{owner\}`\)/);
		assert.doesNotMatch(actions, /const roles = new Map/);
		const api = src("components/outlook-calendar/agenda-api.ts");
		assert.match(api, /export function sourceGroups/);
		assert.match(api, /colleagues\.map\(\(c\) => \[c\]\)/, "un collegue par lecture");
		assert.match(api, /for \(const group of sourceGroups\(sources\)\)/, "prechargement par groupe");
		const hook = src("components/outlook-calendar/use-outlook-events.ts");
		assert.match(hook, /sourceGroups\(sources\)/);
		assert.match(hook, /loadEvents\(identityPublicId, from, days, group, tz\)/);
	});

	Date.now = realNow;
	if (failures) {
		console.log(`\n${failures} test(s) en echec`);
		process.exit(1);
	}
	console.log("\nagenda-speed : tout est vert");
	process.exit(0);
})();
