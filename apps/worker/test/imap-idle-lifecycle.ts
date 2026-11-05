// Cycle de vie de la synchro temps reel IMAP (lib/imap/imap-idle-sync.ts, OI 10346), avec un faux
// ImapFlow et une horloge simulee (realtimeDeps). Verifie : (a) un echec de reconnexion reprogramme
// une tentative (5, 10, 20, 40, 80 s) jusqu'au plafond ; (b) le balayage imap:realtime-recovery
// relance un client mort, ignore les sains, ceux dont la reconnexion est deja programmee et ceux
// qu'on a arretes ; (c) un idle() qui rend la main aussitot ne tourne pas en boucle ; (d) plus de
// reconnexion apres stopRealtimeForIdentity ; (e) jamais deux clients IDLE pour une identite ;
// (f) une erreur de deltaFetch ou de la base sur exists, flags et expunge ne laisse pas de promesse
// rejetee non geree ; (g) plus de reconnexion une fois l'arret du worker commence ; (h) chaque
// IDLE etabli (demarrage, reconnexion) rattrape par deltaFetch les messages arrives pendant la
// coupure (ImapFlow n'emet pas exists au SELECT) ; (i) un serveur qui accepte la connexion puis
// coupe aussitot ne fait pas reconnecter sans fin (le compteur ne repart a zero qu'apres une
// connexion qui a tenu).
// Base de test : voir mcp-test-env.ts :
//   MCP_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55460/kurrier_test \
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/imap-idle-lifecycle.ts
import { assert } from "./mcp-test-env";
import { createUserFixture } from "./mcp-fixtures";
import { db, identities, smtpAccounts } from "@db";
import { eq } from "drizzle-orm";
import { EventEmitter } from "node:events";
import type { ImapFlow } from "imapflow";
import * as realtime from "../lib/imap/imap-idle-sync";
import { deltaFetch } from "../lib/imap/imap-delta-fetch";

const { realtimeDeps, startRealtimeForIdentity, stopRealtimeForIdentity } = realtime;
// Absents avant OI 10346 : lus sans les importer nommement pour que le test reste executable.
const recoverOfflineRealtime = (realtime as any).recoverOfflineRealtime as
	| ((idle: Map<string, ImapFlow>, cmd: Map<string, ImapFlow>) => Promise<void>)
	| undefined;
const beginRealtimeShutdown = (realtime as any).beginRealtimeShutdown as (() => void) | undefined;

const unhandled: unknown[] = [];
process.on("unhandledRejection", (reason) => {
	unhandled.push(reason);
});

// Laisse la base et les promesses se poser (temps reel, pas l'horloge simulee).
const settle = (ms = 40) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const noConnection = () => Object.assign(new Error("Connection not available"), { code: "NoConnection" });

class FakeIdle extends EventEmitter {
	authenticated = true;
	usable = true;
	idling = false;
	idleCalls = 0;
	immediate = false; // idle() rend la main aussitot, comme ImapFlow deja en IDLE
	flap = false; // le serveur coupe des que l'IDLE commence
	private stopIdle?: (err?: Error) => void;
	async getMailboxLock(path: string) {
		return { path, release() {} };
	}
	idle(): Promise<unknown> {
		this.idleCalls++;
		// Garde-fou : une boucle sans pause ne doit pas bloquer le test.
		if (this.idleCalls > 1000) this.drop();
		if (!this.usable) return Promise.reject(noConnection());
		if (this.flap) {
			this.drop();
			return Promise.reject(noConnection());
		}
		if (this.immediate) return Promise.resolve(false);
		this.idling = true;
		return new Promise((resolve, reject) => {
			this.stopIdle = (err) => {
				this.idling = false;
				if (err) reject(err);
				else resolve(true);
			};
		});
	}
	// Coupure reseau ou redemarrage du serveur : comme ImapFlow.close(), la commande en cours est
	// rejetee et "close" est emis.
	drop() {
		if (!this.usable) return;
		this.usable = false;
		this.authenticated = false;
		this.stopIdle?.(noConnection());
		this.emit("close");
	}
	close() {
		this.drop();
	}
	async logout() {
		this.drop();
	}
	async fetchOne() {
		return { uid: 1 };
	}
	async noop() {}
}

class Clock {
	now = 0;
	private seq = 0;
	private timers = new Map<number, { at: number; fn: () => void }>();
	setTimeout = (fn: () => void, ms: number) => {
		const id = ++this.seq;
		this.timers.set(id, { at: this.now + ms, fn });
		return id;
	};
	clearTimeout = (id: unknown) => {
		this.timers.delete(id as number);
	};
	// Declenche les minuteries echues une a une, en laissant la base repondre entre deux.
	async advance(ms: number) {
		const end = this.now + ms;
		for (;;) {
			const next = [...this.timers.entries()]
				.filter(([, t]) => t.at <= end)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.timers.delete(next[0]);
			this.now = next[1].at;
			next[1].fn();
			await settle();
		}
		this.now = end;
		await settle();
	}
}

const clock = new Clock();
const known = new Set<string>(); // identites dont le faux serveur accepte la connexion
const refused = new Set<string>(); // serveur injoignable pour ces identites
const immediateIdle = new Set<string>(); // identites dont idle() rend la main aussitot
const flapping = new Set<string>(); // serveur qui coupe chaque connexion des l'IDLE
const catchUps = new Map<string, number[]>(); // instants des appels a deltaFetch (rattrapage, exists)
const attempts = new Map<string, number[]>(); // instants (horloge simulee) des ouvertures tentees
const opened = new Map<string, FakeIdle[]>();
let openDelayMs = 0;

realtimeDeps.setTimeout = clock.setTimeout;
realtimeDeps.clearTimeout = clock.clearTimeout;
realtimeDeps.now = () => clock.now;
// deltaFetch sur le client de commandes : compte les appels ; le vrai pour l'identite de (f), dont
// la base rejette l'identifiant, pour verifier qu'aucune promesse rejetee ne reste non geree.
realtimeDeps.deltaFetch = async (identityId: string, cmd: Map<string, ImapFlow>) => {
	catchUps.set(identityId, [...(catchUps.get(identityId) ?? []), clock.now]);
	if (identityId === "rt-f-pas-un-uuid") await deltaFetch(identityId, cmd);
};
realtimeDeps.openClient = async (identityId: string, map: Map<string, ImapFlow>) => {
	// Comme initSmtpClient : le client de la table s'il est sain, sinon une nouvelle connexion.
	const existing = map.get(identityId) as unknown as FakeIdle | undefined;
	if (existing?.authenticated && existing?.usable) return existing as unknown as ImapFlow;
	if (existing) map.delete(identityId);
	attempts.set(identityId, [...(attempts.get(identityId) ?? []), clock.now]);
	if (openDelayMs) await settle(openDelayMs);
	if (!known.has(identityId) || refused.has(identityId)) return undefined;
	const client = new FakeIdle();
	client.immediate = immediateIdle.has(identityId);
	client.flap = flapping.has(identityId);
	opened.set(identityId, [...(opened.get(identityId) ?? []), client]);
	map.set(identityId, client as unknown as ImapFlow);
	return client as unknown as ImapFlow;
};

const idleMap = new Map<string, ImapFlow>();
const cmdMap = new Map<string, ImapFlow>();
const tries = (id: string) => attempts.get(id)?.length ?? 0;
const fetches = (id: string) => catchUps.get(id)?.length ?? 0;
const live = (id: string) => (opened.get(id) ?? []).filter((c) => c.usable && c.idling).length;
const last = (id: string) => (opened.get(id) ?? []).at(-1);
const start = (id: string) => startRealtimeForIdentity(id, idleMap, cmdMap);

async function main() {
	// (a) Coupure puis serveur injoignable : 5 tentatives espacees de 5, 10, 20, 40, 80 s.
	known.add("rt-a");
	await start("rt-a");
	await settle();
	assert(live("rt-a") === 1, "(a) client IDLE ouvert");
	refused.add("rt-a");
	const t0 = clock.now;
	last("rt-a")!.drop();
	await settle();
	await clock.advance(10 * 60 * 1000);
	const gaps = (attempts.get("rt-a") ?? []).slice(1).map((t, i, all) => t - (i ? all[i - 1] : t0));
	assert(
		JSON.stringify(gaps) === JSON.stringify([5000, 10000, 20000, 40000, 80000]),
		`(a) un echec de reconnexion reprogramme une tentative jusqu'au plafond (ecarts ${JSON.stringify(gaps)})`,
	);
	await clock.advance(60 * 60 * 1000);
	assert(tries("rt-a") === 6, `(a) plus rien apres le plafond (${tries("rt-a")} ouvertures)`);

	// (c) idle() qui rend la main aussitot : une seule relance par seconde.
	known.add("rt-c");
	immediateIdle.add("rt-c");
	await start("rt-c");
	await settle();
	const callsBefore = last("rt-c")!.idleCalls;
	assert(callsBefore <= 2, `(c) un idle() qui rend la main aussitot ne boucle pas (${callsBefore} appels)`);
	await clock.advance(1000);
	assert(last("rt-c")!.idleCalls <= callsBefore + 1, "(c) la boucle reprend apres une pause d'une seconde");
	await stopRealtimeForIdentity("rt-c", idleMap, cmdMap);

	// (d) Arret d'une identite : pas de reconnexion, ni sur coupure ni sur minuterie deja posee.
	known.add("rt-d");
	await start("rt-d");
	await settle();
	await stopRealtimeForIdentity("rt-d", idleMap, cmdMap);
	await clock.advance(5 * 60 * 1000);
	assert(tries("rt-d") === 1 && live("rt-d") === 0, `(d) plus de reconnexion apres stop (${tries("rt-d")} ouvertures)`);
	known.add("rt-d2");
	await start("rt-d2");
	await settle();
	last("rt-d2")!.drop();
	await settle();
	await stopRealtimeForIdentity("rt-d2", idleMap, cmdMap);
	await clock.advance(5 * 60 * 1000);
	assert(tries("rt-d2") === 1, `(d) la reconnexion deja programmee est annulee par stop (${tries("rt-d2")} ouvertures)`);
	await start("rt-d");
	await settle();
	assert(live("rt-d") === 1, "(d) un demarrage explicite apres stop relance l'identite");
	await stopRealtimeForIdentity("rt-d", idleMap, cmdMap);

	// (e) Demarrages concurrents (job imap:start-idle, synchro du demarrage, balayage) : une connexion.
	known.add("rt-e");
	openDelayMs = 20;
	await Promise.all([start("rt-e"), start("rt-e"), start("rt-e")]);
	await settle(100);
	assert(
		(opened.get("rt-e") ?? []).length === 1 && live("rt-e") === 1,
		`(e) jamais deux clients IDLE pour une identite (${(opened.get("rt-e") ?? []).length} ouverts, ${live("rt-e")} en IDLE)`,
	);
	last("rt-e")!.drop();
	await settle();
	// Reconnexion programmee + demarrage explicite + minuterie : toujours un seul client vivant.
	await Promise.all([start("rt-e"), clock.advance(5000)]);
	await settle(100);
	await clock.advance(5 * 60 * 1000);
	assert(live("rt-e") === 1, `(e) un seul client IDLE apres coupure et redemarrage concurrent (${live("rt-e")})`);
	openDelayMs = 0;
	await stopRealtimeForIdentity("rt-e", idleMap, cmdMap);

	// (f) Gestionnaires d'evenements en echec (identifiant qui n'est pas un uuid : la base leve).
	const bad = "rt-f-pas-un-uuid";
	known.add(bad);
	cmdMap.set(bad, new FakeIdle() as unknown as ImapFlow); // client de commandes pour deltaFetch
	await start(bad);
	await settle();
	const before = unhandled.length;
	const c = last(bad)!;
	c.emit("exists", { path: "INBOX", count: 2, prevCount: 1 });
	c.emit("flags", { path: "INBOX", seq: 1, uid: 7, flags: new Set(["\\Seen"]) });
	c.emit("expunge", { path: "INBOX", seq: 1, uid: 7 });
	await settle(300);
	assert(
		unhandled.length === before,
		`(f) exists, flags et expunge en echec ne laissent pas de promesse rejetee non geree (${unhandled.length - before})`,
	);
	await stopRealtimeForIdentity(bad, idleMap, cmdMap);

	// (b) Balayage imap:realtime-recovery sur de vraies identites (smtp_account_id renseigne).
	const withAccount = async (tag: string) => {
		const f = await createUserFixture(tag);
		const [account] = await db
			.insert(smtpAccounts)
			.values({ ownerId: f.user.id, workspaceId: f.workspace.id })
			.returning();
		await db.update(identities).set({ smtpAccountId: account.id }).where(eq(identities.id, f.identity.id));
		known.add(f.identity.id);
		return f.identity.id;
	};
	const healthy = await withAccount("rt-sain");
	const dead = await withAccount("rt-mort");
	const waiting = await withAccount("rt-attente");
	await start(healthy);
	refused.add(dead);
	await start(dead);
	await settle();
	await clock.advance(10 * 60 * 1000); // plafond atteint pour « dead »
	await start(waiting);
	await settle();
	refused.add(waiting);
	last(waiting)!.drop(); // reconnexion programmee dans 5 s
	await settle();
	assert(typeof recoverOfflineRealtime === "function", "(b) recoverOfflineRealtime exporte");
	if (recoverOfflineRealtime) {
		refused.delete(dead);
		const triesHealthy = tries(healthy);
		const triesWaiting = tries(waiting);
		await recoverOfflineRealtime(idleMap, cmdMap);
		await settle(100);
		assert(live(dead) === 1, "(b) le balayage relance un client mort apres le plafond");
		assert(tries(healthy) === triesHealthy && live(healthy) === 1, "(b) le balayage ignore un client sain");
		assert(tries(waiting) === triesWaiting, "(b) le balayage laisse faire une reconnexion deja programmee");
		await clock.advance(2 * 60 * 1000); // la connexion reprise tient deux minutes
		const t1 = clock.now;
		last(dead)!.drop();
		await settle();
		await clock.advance(5000);
		assert(
			(attempts.get(dead) ?? []).at(-1) === t1 + 5000 && live(dead) === 1,
			"(b) apres une reprise qui a tenu, la reconnexion repart a 5 s",
		);
		await stopRealtimeForIdentity(healthy, idleMap, cmdMap);
		const triesStopped = tries(healthy);
		await recoverOfflineRealtime(idleMap, cmdMap);
		await settle(100);
		assert(tries(healthy) === triesStopped, "(b) le balayage ne relance pas une identite arretee");
	}

	// (h) Rattrapage : l'IDLE ne voit pas ce qui est arrive pendant la coupure, deltaFetch le fait.
	known.add("rt-h");
	await start("rt-h");
	await settle();
	assert(fetches("rt-h") === 1, `(h) un rattrapage des que l'IDLE est etabli (${fetches("rt-h")})`);
	await clock.advance(60 * 1000);
	const tDrop = clock.now;
	last("rt-h")!.drop();
	await settle();
	await clock.advance(5000);
	assert(
		live("rt-h") === 1 && fetches("rt-h") === 2 && catchUps.get("rt-h")!.at(-1) === tDrop + 5000,
		`(h) un rattrapage apres la reconnexion (${fetches("rt-h")} appels)`,
	);
	await stopRealtimeForIdentity("rt-h", idleMap, cmdMap);

	// (i) Serveur qui accepte la connexion puis coupe aussitot : pas de reconnexion toutes les 5 s.
	known.add("rt-i");
	flapping.add("rt-i");
	await start("rt-i");
	await settle();
	await clock.advance(30 * 60 * 1000);
	assert(tries("rt-i") <= 6, `(i) un serveur qui coupe aussitot ne fait pas reconnecter sans fin (${tries("rt-i")} ouvertures en 30 min)`);
	await stopRealtimeForIdentity("rt-i", idleMap, cmdMap);

	// (g) Arret du worker : la reconnexion programmee est annulee, plus aucun demarrage.
	known.add("rt-g");
	known.add("rt-g2");
	await start("rt-g");
	await settle();
	last("rt-g")!.drop();
	await settle();
	assert(typeof beginRealtimeShutdown === "function", "(g) beginRealtimeShutdown exporte");
	beginRealtimeShutdown?.();
	await clock.advance(10 * 60 * 1000);
	await start("rt-g2");
	await settle();
	assert(tries("rt-g") === 1 && tries("rt-g2") === 0, `(g) plus de reconnexion pendant l'arret (${tries("rt-g")}, ${tries("rt-g2")})`);
}

main()
	.catch((err) => {
		console.error(err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
