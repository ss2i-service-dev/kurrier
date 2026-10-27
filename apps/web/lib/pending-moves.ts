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
const pending = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot = new Set<string>();

const key = (mailboxId: string, threadId: string) => `${mailboxId}:${threadId}`;

function publish() {
	const now = Date.now();
	for (const [k, until] of pending) if (until < now) pending.delete(k);
	snapshot = new Set(pending.keys());
	listeners.forEach((l) => l());
}

export function hideThreads(mailboxId: string, threadIds: string[]) {
	const until = Date.now() + TTL_MS;
	threadIds.forEach((id) => pending.set(key(mailboxId, id), until));
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
): Promise<T> {
	hideThreads(mailboxId, threadIds);
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

export function moveWithUndo<T>({
	mailboxId,
	threadIds,
	message,
	run,
	onDone,
	failure = "Action failed, messages restored",
}: {
	mailboxId: string;
	threadIds: string[];
	message: string;
	run: () => Promise<T>;
	onDone?: (result: T) => void;
	failure?: string;
}) {
	if (!threadIds.length) return;
	hideThreads(mailboxId, threadIds);
	const fire = () => {
		clearTimeout(timer);
		waiting.delete(fire);
		optimisticMove(mailboxId, threadIds, run)
			.then((r) => onDone?.(r))
			.catch((e: any) =>
				toast.error(e?.message ?? failure, { position: "bottom-left" }),
			);
	};
	const timer = setTimeout(fire, UNDO_MS);
	waiting.add(fire);
	toast.success(message, {
		position: "bottom-left",
		duration: UNDO_MS,
		action: {
			label: "Undo",
			onClick: () => {
				if (!waiting.delete(fire)) return; // deja envoye
				clearTimeout(timer);
				showThreads(mailboxId, threadIds);
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
const empty = new Set<string>();

export function useHiddenThreads() {
	const hidden = useSyncExternalStore(subscribe, () => snapshot, () => empty);
	return (mailboxId: string, threadId: string) =>
		hidden.has(key(mailboxId, threadId));
}
