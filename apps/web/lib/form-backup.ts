// ss2i : copie locale (localStorage) des formulaires d'agenda en cours de saisie.
//
// Meme raison que draft-backup.ts pour les mails : l'onglet est recharge de force apres chaque
// deploiement (version-watcher), ou par F5, ou plante, et ce qui n'est pas enregistre cote
// serveur disparait. Un formulaire (creation ou modification d'evenement, evenement depuis un
// mail) ecrit ici tout son etat a chaque modification, sous une cle stable ; a la reouverture
// du meme formulaire la copie est proposee. Elle est retiree quand l'enregistrement a reussi
// ou que l'utilisateur annule ; une fermeture par erreur (clic dehors, Echap) la garde.
// Module pur : aucune dependance a React, tolerant au quota et a l'absence de window.

export const FORM_BACKUP_PREFIX = "ss2i-form-backup:";
/** Une copie plus ancienne est purgee. */
export const FORM_BACKUP_MAX_AGE = 7 * 24 * 3600 * 1000;
/** Au-dela, une copie n'est plus rouverte d'office apres un rechargement. */
export const FORM_BACKUP_REOPEN_AGE = 24 * 3600 * 1000;

export type FormValues = Record<string, unknown>;

export type FormBackup<T extends FormValues = FormValues> = {
	v: 1;
	key: string;
	values: T;
	updatedAt: number;
};

// Cles stables : un formulaire rouvert retrouve sa copie.
export const agendaNewKey = (identityPublicId: string) => `agenda:new:${identityPublicId}`;
export const agendaEditKey = (eventId: string) => `agenda:edit:${eventId}`;
export const agendaFromMailKey = (messageId: string) => `agenda:from-mail:${messageId}`;

function storage(): Storage | null {
	try {
		return typeof window === "undefined" || !window ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function readFormBackup<T extends FormValues = FormValues>(key: string): FormBackup<T> | null {
	const s = storage();
	if (!s) return null;
	try {
		const raw = s.getItem(FORM_BACKUP_PREFIX + key);
		const b = raw ? (JSON.parse(raw) as FormBackup<T>) : null;
		return b?.v === 1 && b.values && typeof b.values === "object" ? b : null;
	} catch {
		return null;
	}
}

export function writeFormBackup(key: string, values: FormValues, now = Date.now()): boolean {
	const s = storage();
	if (!s) return false;
	const raw = JSON.stringify({ v: 1, key, values, updatedAt: now } satisfies FormBackup);
	try {
		s.setItem(FORM_BACKUP_PREFIX + key, raw);
		return true;
	} catch {
		// Quota : les copies anciennes font place, un seul nouvel essai.
		purgeFormBackups(FORM_BACKUP_MAX_AGE, now);
		try {
			s.setItem(FORM_BACKUP_PREFIX + key, raw);
			return true;
		} catch {
			return false;
		}
	}
}

export function removeFormBackup(key: string) {
	const s = storage();
	if (!s) return;
	try {
		s.removeItem(FORM_BACKUP_PREFIX + key);
	} catch {}
}

/** Copies (lisibles) dont la cle commence par `prefix`. */
export function listFormBackups(prefix = ""): FormBackup[] {
	const s = storage();
	if (!s) return [];
	const out: FormBackup[] = [];
	try {
		for (let i = 0; i < s.length; i++) {
			const k = s.key(i);
			if (!k?.startsWith(FORM_BACKUP_PREFIX + prefix)) continue;
			const b = readFormBackup(k.slice(FORM_BACKUP_PREFIX.length));
			if (b) out.push(b);
		}
	} catch {}
	return out;
}

/** Retire les copies de plus de `maxAgeMs` (et celles qu'on ne sait plus lire) ; rend leur nombre. */
export function purgeFormBackups(maxAgeMs = FORM_BACKUP_MAX_AGE, now = Date.now()): number {
	const s = storage();
	if (!s) return 0;
	let n = 0;
	try {
		const keys: string[] = [];
		for (let i = 0; i < s.length; i++) {
			const k = s.key(i);
			if (k?.startsWith(FORM_BACKUP_PREFIX)) keys.push(k);
		}
		for (const k of keys) {
			const b = readFormBackup(k.slice(FORM_BACKUP_PREFIX.length));
			if (b && now - b.updatedAt <= maxAgeMs) continue;
			s.removeItem(k);
			n++;
		}
	} catch {}
	return n;
}

// JSON a cles triees, sans les champs undefined : deux etats egaux se comparent egaux, meme
// apres un aller-retour par localStorage.
function stable(x: unknown): string {
	return JSON.stringify(x, (_k, val) =>
		val && typeof val === "object" && !Array.isArray(val)
			? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: val,
	);
}

/** La saisie differe-t-elle de l'etat initial ? Seuls les champs de `initial` comptent. */
export function differsFromInitial(values: FormValues, initial: FormValues): boolean {
	return Object.keys(initial).some((k) => stable(values[k]) !== stable(initial[k]));
}

/** Copie de ce formulaire si elle existe et differe de l'etat initial, sinon null. */
export function restorableBackup<T extends FormValues = FormValues>(key: string, initial: FormValues): FormBackup<T> | null {
	const b = readFormBackup<T>(key);
	return b && differsFromInitial(b.values, initial) ? b : null;
}

/** A chaque modification : copie ecrite tant que la saisie differe, retiree quand elle revient a l'initial. */
export function syncFormBackup(key: string, values: FormValues, initial: FormValues) {
	if (differsFromInitial(values, initial)) writeFormBackup(key, values);
	else removeFormBackup(key);
}

/** Copie la plus recente (moins de `maxAgeMs`) parmi les cles commencant par l'un des prefixes. */
export function recentFormBackup(prefixes: string[], maxAgeMs = FORM_BACKUP_REOPEN_AGE, now = Date.now()): FormBackup | null {
	let best: FormBackup | null = null;
	for (const p of prefixes) {
		for (const b of listFormBackups(p)) {
			if (now - b.updatedAt > maxAgeMs) continue;
			if (!best || b.updatedAt > best.updatedAt) best = b;
		}
	}
	return best;
}
