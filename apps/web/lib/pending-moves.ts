"use client";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

// ss2i : fils retires de l'affichage des le clic (corbeille, archive, deplacement,
// suppression definitive), sans attendre le worker. Avant, rien ne bougeait a l'ecran
// pendant que les jobs passaient un a un, et la selection disparaissait au compte-gouttes.
// Cle = dossier + fil : le meme fil doit rester visible dans son dossier d'arrivee.
// Duree de vie bornee : si le deplacement echoue sans erreur remontee, le fil
// revient a l'affichage suivant au lieu de disparaitre pour toujours.
const TTL_MS = 10 * 60 * 1000;
// ss2i : valeur = echeance et nature du depart. Archiver ne fait que sortir le fil de
// l'Inbox : un dossier client (qui montre aussi les archives) le garde a l'ecran.
const pending = new Map<string, { until: number; archive: boolean }>();
const listeners = new Set<() => void>();
let snapshot = new Map<string, boolean>();

const key = (mailboxId: string, threadId: string) => `${mailboxId}:${threadId}`;

function publish() {
	const now = Date.now();
	for (const [k, v] of pending) if (v.until < now) pending.delete(k);
	snapshot = new Map([...pending].map(([k, v]) => [k, v.archive]));
	listeners.forEach((l) => l());
}

export function hideThreads(mailboxId: string, threadIds: string[], archive = false) {
	const until = Date.now() + TTL_MS;
	threadIds.forEach((id) => pending.set(key(mailboxId, id), { until, archive }));
	publish();
}

export function showThreads(mailboxId: string, threadIds: string[]) {
	threadIds.forEach((id) => pending.delete(key(mailboxId, id)));
	publish();
}

// Masque tout de suite, lance l'action, et fait reapparaitre les fils si elle echoue.
export async function optimisticMove<T>(
	mailboxId: string,
	threadIds: string[],
	run: () => Promise<T>,
	archive = false,
): Promise<T> {
	hideThreads(mailboxId, threadIds, archive);
	try {
		return await run();
	} catch (err) {
		showThreads(mailboxId, threadIds);
		throw err;
	}
}

// ss2i : fenetre d'annulation, comme Gmail. Les fils quittent la liste tout de suite,
// mais l'action n'est envoyee au serveur qu'apres UNDO_MS : « Undo » dans le toast les
// remet a l'affichage sans qu'aucun aller-retour IMAP n'ait eu lieu.
const UNDO_MS = 6000;

// ss2i : nouvelle interface (<html data-ui="ss2i">) : libelle francais, toast centre.
// Classique : inchange.
const nouvelle = () => typeof document !== "undefined" && document.documentElement.dataset.ui === "ss2i";

export function moveWithUndo<T>({
	mailboxId,
	threadIds,
	message,
	run,
	onDone,
	onUndo,
	failure = "Action failed, messages restored",
	archive = false,
}: {
	mailboxId: string;
	threadIds: string[];
	message: string;
	run: () => Promise<T>;
	onDone?: (result: T) => void;
	// ss2i : appele si l'utilisateur annule (nouvelle interface : compteurs). Optionnel.
	onUndo?: () => void;
	failure?: string;
	archive?: boolean;
}) {
	if (!threadIds.length) return;
	hideThreads(mailboxId, threadIds, archive);
	const fire = () => {
		clearTimeout(timer);
		waiting.delete(fire);
		optimisticMove(mailboxId, threadIds, run, archive)
			.then((r) => onDone?.(r))
			.catch((e: any) =>
				toast.error(e?.message ?? failure, { position: "bottom-left" }),
			);
	};
	const timer = setTimeout(fire, UNDO_MS);
	waiting.add(fire);
	toast.success(message, {
		position: nouvelle() ? "bottom-center" : "bottom-left",
		duration: UNDO_MS,
		action: {
			label: nouvelle() ? "Annuler" : "Undo",
			onClick: () => {
				if (!waiting.delete(fire)) return; // deja envoye
				clearTimeout(timer);
				showThreads(mailboxId, threadIds);
				onUndo?.();
			},
		},
	});
}

// Onglet ferme ou quitte pendant la fenetre d'annulation : on envoie tout de suite,
// sinon la suppression demandee serait perdue en silence.
const waiting = new Set<() => void>();
if (typeof window !== "undefined") {
	window.addEventListener("pagehide", () => [...waiting].forEach((f) => f()));
}

const subscribe = (l: () => void) => {
	listeners.add(l);
	return () => listeners.delete(l);
};
const empty = new Map<string, boolean>();

// keepArchived : vue qui contient aussi les archives (dossier client), un fil archive y reste.
export function useHiddenThreads({ keepArchived = false }: { keepArchived?: boolean } = {}) {
	const hidden = useSyncExternalStore(subscribe, () => snapshot, () => empty);
	return (mailboxId: string, threadId: string) => {
		const k = key(mailboxId, threadId);
		return hidden.has(k) && !(keepArchived && hidden.get(k));
	};
}
