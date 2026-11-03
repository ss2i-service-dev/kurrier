"use client";
// SS2i (nouvelle interface) : etat optimiste de la messagerie.
//
// Archiver, supprimer, deplacer : on passe par lib/pending-moves (moveWithUndo),
// le meme mecanisme que l'interface classique (fil retire des le clic, toast
// avec Undo, action envoyee ensuite). Ce module ne garde que ce que
// pending-moves ne couvre pas : lu / non lu et etoile instantanes, fil actif,
// nouveau message en cours.
//
// Les actions serveur (archiver, supprimer, lu/non lu, etoile) passent par le
// worker IMAP et, avec refresh=true, attendent que la base reflete le
// changement avant de redessiner : de 0,3 a 5 s pendant lesquelles l'ecran ne
// bougeait pas. Ici, l'interface applique l'effet tout de suite, l'action part
// en arriere-plan avec refresh=false, et un rafraichissement discret
// reconcilie l'affichage (compteurs de la barre laterale) une fois l'activite
// retombee. En cas d'echec, l'effet est annule et un message s'affiche.
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
	archiveThread,
	markAsRead,
	markAsUnread,
	moveToTrash,
	toggleStar,
} from "@/lib/actions/mailbox";
import { hideThreads, moveWithUndo } from "@/lib/pending-moves";
import { setThreadPinned } from "@/lib/actions/k-pins";
import { refreshUnreadBadge } from "@/components/k/new-mail-notifier";

type State = {
	read: Map<string, boolean>;
	starred: Map<string, boolean>;
	/** Epinglage (fil -> epingle ou non), applique avant la reponse du serveur. */
	pinned: Map<string, boolean>;
	/** Fil en cours de fermeture : le panneau de lecture se masque sans attendre le routeur. */
	closing: string | null;
	/** Fil ouvert (ou en cours d'ouverture) : seule sa ligne et l'ancienne se redessinent. */
	active: string | null;
	/** Nouveau message en cours : il occupe le panneau de lecture. */
	composing: boolean;
	/** Emplacement fourni par le panneau de lecture pour l'editeur. */
	composeSlot: HTMLElement | null;
	/** Envoi annulable en cours : l'editeur reste monte mais le panneau rend la main. */
	composeParked: boolean;
	/**
	 * Ajustements des compteurs de la barre laterale (dossier -> ecart), appliques
	 * des l'action ; chacun tombe quand le serveur renvoie une valeur differente de
	 * celle sur laquelle il a ete pose (le serveur a pris l'action en compte).
	 */
	countAdj: Map<string, { delta: number; base: number }>;
};

// Etat initial, identique cote serveur : c'est lui que React compare au HTML
// pendant l'hydratation (sinon une ligne deja marquee active cote navigateur
// ne correspond plus au rendu serveur : erreur d'hydratation).
const INITIAL: State = { read: new Map(), starred: new Map(), pinned: new Map(), closing: null, active: null, composing: false, composeSlot: null, composeParked: false, countAdj: new Map() };
let state: State = INITIAL;
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
	state = { ...state, ...next };
	listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
	listeners.add(l);
	return () => listeners.delete(l);
}

export function useMailStore<T>(select: (s: State) => T): T {
	return useSyncExternalStore(subscribe, () => select(state), () => select(INITIAL));
}

export function openCompose() {
	if (!state.composing) set({ composing: true });
}
export function closeCompose() {
	if (state.composing) set({ composing: false });
}
export function setComposeParked(v: boolean) {
	if (state.composeParked !== v) set({ composeParked: v });
}
export function setComposeSlot(el: HTMLElement | null) {
	if (state.composeSlot !== el) set({ composeSlot: el });
}

export function setClosingThread(threadId: string | null) {
	if (state.closing !== threadId) set({ closing: threadId });
}

/** Fil actif : appele au clic (avant la reponse du serveur) et a chaque changement d'URL. */
export function setActiveThread(threadId: string | null) {
	if (state.active !== threadId) set({ active: threadId });
}

// Rafraichissement differe : un seul router.refresh apres une salve d'actions.
let refresher: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
export function registerRefresher(fn: () => void) {
	refresher = fn;
}
export function scheduleRefresh(delay = 2500) {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		refresher?.();
		// Pastille de l'onglet a jour apres lecture, archivage, suppression...
		refreshUnreadBadge();
	}, delay);
}

/**
 * Appele quand de nouvelles donnees serveur arrivent pour la liste : on retire
 * les surcharges que le serveur confirme desormais (lu, etoile).
 */
export function settle(rows: { threadId: string; unreadCount: number; starred: boolean }[]) {
	const byId = new Map(rows.map((r) => [String(r.threadId), r]));
	const read = new Map([...state.read].filter(([id, v]) => {
		const r = byId.get(id);
		return r ? (r.unreadCount === 0) !== v : false;
	}));
	const starred = new Map([...state.starred].filter(([id, v]) => {
		const r = byId.get(id);
		return r ? r.starred !== v : false;
	}));
	if (read.size !== state.read.size || starred.size !== state.starred.size) {
		set({ read, starred });
	}
}

/** Epinglages confirmes par le serveur : les surcharges correspondantes tombent. */
export function settlePins(serverPinned: Set<string>) {
	if (!state.pinned.size) return;
	const pinned = new Map([...state.pinned].filter(([id, v]) => serverPinned.has(id) !== v));
	if (pinned.size !== state.pinned.size) set({ pinned });
}

async function run(
	apply: () => void,
	revert: () => void,
	call: () => Promise<unknown>,
	fail: string,
) {
	apply();
	try {
		await call();
		scheduleRefresh(800);
	} catch (e: any) {
		revert();
		toast.error(e?.message ?? fail, { position: "bottom-center" });
	}
}

const ids = (x: string | string[]) => (Array.isArray(x) ? x : [x]);

function setRead(threadIds: string[], value: boolean | null) {
	const read = new Map(state.read);
	threadIds.forEach((id) => (value === null ? read.delete(id) : read.set(id, value)));
	set({ read });
}

// Derniers compteurs recus du serveur (fournis par la barre laterale).
let serverCounts = new Map<string, number>();

// Fils remis en non lu a la main pendant cette session : l'ouverture automatique
// (lecteur deja affiche, rechargement du panneau apres actualisation) ne doit pas
// les remarquer lus. Seule une action explicite (clic sur la ligne, « Marquer
// comme lu ») les relit.
const manualUnread = new Set<string>();
export function isManuallyUnread(threadId: string) {
	return manualUnread.has(String(threadId));
}

/** Fil deja marque lu a l'ecran (au clic dans la liste) : pas de second marquage. */
export function isMarkedRead(threadId: string) {
	return state.read.get(String(threadId)) === true;
}

/** La barre laterale transmet les compteurs serveur a chaque rendu. */
export function syncServerCounts(next: Map<string, number>) {
	serverCounts = next;
	if (!state.countAdj.size) return;
	const kept = new Map([...state.countAdj].filter(([id, a]) => (next.get(id) ?? 0) === a.base));
	if (kept.size !== state.countAdj.size) set({ countAdj: kept });
}

/** Ajuste tout de suite le compteur d'un dossier (n negatif : moins de non-lus). */
export function adjustCount(mailboxId: string, n: number) {
	if (!n || !mailboxId) return;
	const countAdj = new Map(state.countAdj);
	const cur = countAdj.get(mailboxId);
	countAdj.set(mailboxId, { delta: (cur?.delta ?? 0) + n, base: cur?.base ?? serverCounts.get(mailboxId) ?? 0 });
	set({ countAdj });
}

export const mailActions = {
	/** unread : nombre de fils non lus parmi ceux deplaces (compteur du dossier). */
	archive(threadIds: string | string[], mailboxId: string, smtp: boolean, unread = 0) {
		const list = ids(threadIds);
		adjustCount(mailboxId, -unread);
		moveWithUndo({
			onUndo: () => adjustCount(mailboxId, unread),
			mailboxId,
			threadIds: list,
			message: list.length > 1 ? `${list.length} fils archivés` : "Archivé",
			// refresh=false : pas d'attente du worker ni de rendu complet de la page ;
			// le fil est deja masque, un rafraichissement discret suit.
			// archiver ne fait que sortir le fil de l'Inbox (patch 0081)
			archive: true,
			run: () => archiveThread(list, mailboxId, smtp, false),
			onDone: () => scheduleRefresh(),
			failure: "L'archivage a échoué",
		});
	},
	trash(threadIds: string | string[], mailboxId: string, smtp: boolean, inTrash = false, unread = 0) {
		const list = ids(threadIds);
		adjustCount(mailboxId, -unread);
		moveWithUndo({
			onUndo: () => adjustCount(mailboxId, unread),
			mailboxId,
			threadIds: list,
			message: inTrash ? "Supprimé définitivement" : "Déplacé dans la corbeille",
			run: () => moveToTrash(list, mailboxId, smtp, false),
			onDone: () => scheduleRefresh(),
			failure: "La suppression a échoué",
		});
	},
	/** Deplacement fait ailleurs (dossier, pas un spam) : masque seulement. */
	hide(mailboxId: string, threadIds: string | string[]) {
		hideThreads(mailboxId, ids(threadIds));
	},
	/** unread : nombre de fils reellement non lus parmi la liste (compteur du dossier). */
	read(threadIds: string | string[], mailboxId: string, smtp: boolean, unread = 0) {
		const list = ids(threadIds);
		list.forEach((id) => manualUnread.delete(String(id)));
		const before = list.map((id) => state.read.get(id));
		return run(
			() => {
				setRead(list, true);
				adjustCount(mailboxId, -unread);
			},
			() => {
				list.forEach((id, i) => setRead([id], before[i] ?? null));
				adjustCount(mailboxId, unread);
			},
			() => markAsRead(list, mailboxId, smtp, false),
			"Action impossible",
		);
	},
	/** read : nombre de fils lus parmi la liste, qui redeviennent non lus. */
	unread(threadIds: string | string[], mailboxId: string, smtp: boolean, read = 0) {
		const list = ids(threadIds);
		list.forEach((id) => manualUnread.add(String(id)));
		const before = list.map((id) => state.read.get(id));
		return run(
			() => {
				setRead(list, false);
				adjustCount(mailboxId, read);
			},
			() => {
				list.forEach((id, i) => setRead([id], before[i] ?? null));
				adjustCount(mailboxId, -read);
			},
			() => markAsUnread(list, mailboxId, smtp, false),
			"Action impossible",
		);
	},
	/** Epingler / desepingler un fil : en tete de son dossier, pour soi seulement. */
	pin(threadId: string, value: boolean) {
		const id = String(threadId);
		const before = state.pinned.get(id);
		return run(
			() => {
				const pinned = new Map(state.pinned);
				pinned.set(id, value);
				set({ pinned });
			},
			() => {
				const pinned = new Map(state.pinned);
				if (before === undefined) pinned.delete(id);
				else pinned.set(id, before);
				set({ pinned });
			},
			async () => {
				const res = await setThreadPinned(id, value);
				if (!res?.success) throw new Error(res?.error || "Action impossible");
				toast.success(value ? "Fil épinglé" : "Fil désépinglé", { position: "bottom-center", duration: 2000 });
			},
			"Action impossible",
		);
	},
	star(threadId: string, mailboxId: string, current: boolean, smtp: boolean) {
		const starred = new Map(state.starred);
		starred.set(threadId, !current);
		return run(
			() => set({ starred }),
			() => {
				const s = new Map(state.starred);
				s.delete(threadId);
				set({ starred: s });
			},
			() => toggleStar(threadId, mailboxId, current, smtp),
			"Action impossible",
		);
	},
};
