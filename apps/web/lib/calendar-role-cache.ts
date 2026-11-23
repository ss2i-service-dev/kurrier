// ss2i : droits de l'utilisateur sur l'agenda d'un collegue, gardes dans Redis.
//
// Mesure du 23/11/2026 sur hlm (boite jb) : la lecture des droits (calendarPermissions) prend
// 18 a 20 s a froid pour samuel, nicolas et support, puis 0,8 a 2 s, alors que les evenements
// d'une semaine arrivent en 0,1 a 0,5 s. Le droit n'etait garde que 30 min en memoire et perdu a
// chaque redemarrage du web : la premiere ouverture de l'agenda apres un deploiement attendait
// ces 20 s, tous agendas confondus.
//
// Ici, relu sur Graph au plus toutes les 30 min comme avant, mais garde 7 jours dans Redis : le
// dernier droit connu sert tout de suite, et un droit de plus de 30 min est relu en
// arriere-plan (stale-while-revalidate). Un partage retire est donc pris en compte des la
// relecture qui suit la premiere ouverture, au lieu de 30 min au plus.
// Redis indisponible : on se rabat sur la memoire du processus, puis sur Graph.
import Redis from "ioredis";

export type RoleEntry<R extends string = string> = { at: number; role: R };

export const ROLE_FRESH_MS = 30 * 60_000;
export const ROLE_MAX_STALE_MS = 7 * 24 * 3600_000;
const REDIS_TIMEOUT_MS = 300;
const PREFIX = "ss2i:calendar-role:";

/** fresh : a servir ; stale : a servir et a relire en arriere-plan ; miss : a lire avant de repondre. */
export function roleDecision(entry: RoleEntry | null | undefined, now: number): "fresh" | "stale" | "miss" {
	if (!entry || typeof entry.at !== "number" || typeof entry.role !== "string") return "miss";
	const age = now - entry.at;
	if (age < 0 || age >= ROLE_MAX_STALE_MS) return "miss";
	return age < ROLE_FRESH_MS ? "fresh" : "stale";
}

let client: Redis | null | undefined;
function redis(): Redis | null {
	if (client !== undefined) return client;
	try {
		// Memes variables que lib/actions/get-redis.ts (lues ici sans @schema : module testable par tsx).
		const { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD } = process.env;
		client = new Redis({
			host: REDIS_HOST || "redis",
			port: Number(REDIS_PORT || 6379),
			password: REDIS_PASSWORD || undefined,
			maxRetriesPerRequest: 1,
			connectTimeout: 2000,
		});
		client.on("error", () => {});
	} catch {
		client = null;
	}
	return client;
}

const withTimeout = <T>(p: Promise<T>): Promise<T | null> =>
	Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), REDIS_TIMEOUT_MS))]);

async function readStored<R extends string>(key: string): Promise<RoleEntry<R> | null> {
	const r = redis();
	if (!r) return null;
	const raw = await withTimeout(r.get(PREFIX + key));
	if (!raw) return null;
	try {
		const v = JSON.parse(raw);
		return roleDecision(v, Date.now()) === "miss" ? null : (v as RoleEntry<R>);
	} catch {
		return null;
	}
}

function writeStored(key: string, entry: RoleEntry) {
	const r = redis();
	if (!r) return;
	void withTimeout(r.set(PREFIX + key, JSON.stringify(entry), "PX", ROLE_MAX_STALE_MS));
}

const memory = new Map<string, RoleEntry>();
const inflight = new Map<string, Promise<string>>();

/**
 * Droit pour la cle `key` (« moi>collegue »). `read` interroge Graph ; il n'est attendu que
 * si aucun droit de moins de 7 jours n'est connu.
 */
export async function cachedRole<R extends string>(key: string, read: () => Promise<R>): Promise<R> {
	let entry = memory.get(key) as RoleEntry<R> | undefined;
	if (roleDecision(entry, Date.now()) === "miss") {
		const stored = await readStored<R>(key);
		if (stored) memory.set(key, (entry = stored));
	}
	const refresh = (): Promise<R> => {
		const running = inflight.get(key);
		if (running) return running as Promise<R>;
		const p = read()
			.then((role) => {
				const e = { at: Date.now(), role };
				memory.set(key, e);
				writeStored(key, e);
				return role;
			})
			.finally(() => inflight.delete(key));
		inflight.set(key, p);
		return p;
	};
	const d = roleDecision(entry, Date.now());
	if (d === "fresh") return (entry as RoleEntry<R>).role;
	if (d === "stale") {
		// Le dernier droit connu sert tout de suite ; un echec de la relecture le laisse en place.
		refresh().catch(() => {});
		return (entry as RoleEntry<R>).role;
	}
	return refresh();
}

/** Oublie le droit connu (ajout explicite d'un collegue : relecture sur Graph). */
export async function forgetRole(key: string) {
	memory.delete(key);
	const r = redis();
	if (r) await withTimeout(r.del(PREFIX + key));
}
