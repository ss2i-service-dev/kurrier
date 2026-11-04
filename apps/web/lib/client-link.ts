"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { isProIdentityPublicId, linkThreadsToClient, undoLinkThreadsToClient } from "@/lib/actions/thread-clients";

// ss2i : rattachement manuel d'un fil a un client (OI 10270), cote navigateur. Glisser une
// ligne de la liste (poignee) ou la selection sur un client de la section Clients de la barre
// laterale, ou « Rattacher a un client... » ; toast « Rattache a <client> » avec Annuler.
// Le fil rattache sort tout de suite du dossier « Sans client » (useLinkedThreads), sans
// attendre l'actualisation de la page.

export const THREAD_DRAG_TYPE = "application/x-courrier-threads";

export type ThreadDragPayload = { identityPublicId: string; threadIds: string[]; label: string };

// Glisser en cours (meme fenetre) : les cibles ne peuvent pas lire dataTransfer avant le
// depot, seulement ses types ; elles lisent ici l'identite des fils glisses.
let dragging: ThreadDragPayload | null = null;
const dragListeners = new Set<() => void>();
const publishDrag = (p: ThreadDragPayload | null) => {
	dragging = p;
	dragListeners.forEach((l) => l());
};

export function startThreadDrag(e: React.DragEvent, payload: ThreadDragPayload) {
	e.dataTransfer.setData(THREAD_DRAG_TYPE, JSON.stringify(payload));
	e.dataTransfer.setData("text/plain", payload.label);
	e.dataTransfer.effectAllowed = "link";
	// Image du glisser : une pastille avec l'objet ou le nombre de fils.
	const ghost = document.createElement("div");
	ghost.textContent = payload.label;
	ghost.style.cssText =
		"position:fixed;top:-1000px;left:-1000px;max-width:320px;padding:4px 10px;border-radius:999px;" +
		"background:#1f2937;color:#fff;font:500 12px system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
	document.body.appendChild(ghost);
	e.dataTransfer.setDragImage(ghost, 14, 14);
	// Differe : modifier le DOM pendant dragstart peut annuler le glisser (Chrome).
	setTimeout(() => {
		ghost.remove();
		publishDrag(payload);
	}, 0);
}

export function endThreadDrag() {
	if (dragging) publishDrag(null);
}

// Ligne retiree de la liste pendant le glisser (actualisation) : son dragend n'arrive pas.
// Aucun mousemove n'est emis pendant un glisser : le premier qui arrive dit qu'il est fini.
if (typeof window !== "undefined") {
	for (const ev of ["dragend", "drop", "mousemove"]) window.addEventListener(ev, () => endThreadDrag());
}

export const isThreadDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(THREAD_DRAG_TYPE);

export function readThreadDrag(e: React.DragEvent): ThreadDragPayload | null {
	try {
		const p = JSON.parse(e.dataTransfer.getData(THREAD_DRAG_TYPE) || "null");
		if (p && typeof p.identityPublicId === "string" && Array.isArray(p.threadIds)) return p;
	} catch {}
	return dragging;
}

const subscribeDrag = (l: () => void) => {
	dragListeners.add(l);
	return () => dragListeners.delete(l);
};
/** Fils en cours de glisser (null hors glisser). */
export function useThreadDrag() {
	return useSyncExternalStore(subscribeDrag, () => dragging, () => null);
}

// Fils rattaches depuis cette page : retires du dossier « Sans client » tout de suite.
let linked = new Set<string>();
const linkedListeners = new Set<() => void>();
const linkedKey = (identityPublicId: string, threadId: string) => `${identityPublicId}:${threadId}`;
function setLinked(identityPublicId: string, threadIds: string[], on: boolean) {
	const next = new Set(linked);
	for (const id of threadIds) {
		if (on) next.add(linkedKey(identityPublicId, id));
		else next.delete(linkedKey(identityPublicId, id));
	}
	linked = next;
	linkedListeners.forEach((l) => l());
}
const subscribeLinked = (l: () => void) => {
	linkedListeners.add(l);
	return () => linkedListeners.delete(l);
};
const noneLinked = new Set<string>();
export function useLinkedThreads() {
	const set = useSyncExternalStore(subscribeLinked, () => linked, () => noneLinked);
	return (identityPublicId: string, threadId: string) => set.has(linkedKey(identityPublicId, threadId));
}

// Identite pro (section Clients) : une question au serveur par identite et par page.
const proCache = new Map<string, Promise<boolean>>();
export function useIsProIdentity(identityPublicId: string | undefined) {
	const [pro, setPro] = useState(false);
	useEffect(() => {
		if (!identityPublicId) return;
		let alive = true;
		let p = proCache.get(identityPublicId);
		if (!p) {
			p = isProIdentityPublicId(identityPublicId).catch(() => false);
			proCache.set(identityPublicId, p);
		}
		p.then((v) => alive && setPro(v));
		return () => {
			alive = false;
		};
	}, [identityPublicId]);
	return pro;
}

// Interface « Outlook » (<html data-ui="ss2i">) : francais, toast centre (comme pending-moves).
const nouvelle = () => typeof document !== "undefined" && document.documentElement.dataset.ui === "ss2i";

/**
 * Rattache les fils au client, toast « Rattache a <client> » avec Annuler. `refresh` met a
 * jour la barre laterale (nouveau client, compteurs) et la liste.
 */
export async function linkThreadsWithUndo({
	identityPublicId,
	threadIds,
	companyId,
	refresh,
	archive = true,
}: {
	identityPublicId: string;
	threadIds: string[];
	companyId: number;
	refresh: () => void;
	// ss2i : mettre un fil dans un client l'archive (sortie de l'Inbox), sauf demande contraire.
	archive?: boolean;
}) {
	const fr = nouvelle();
	const position = fr ? "bottom-center" : "bottom-left";
	if (!threadIds.length) return false;
	setLinked(identityPublicId, threadIds, true);
	const res = await linkThreadsToClient(identityPublicId, threadIds, companyId, { archive }).catch((e: any) => ({
		success: false as const,
		error: String(e?.message ?? e),
	}));
	if (!res.success) {
		setLinked(identityPublicId, threadIds, false);
		toast.error(fr ? `Rattachement impossible : ${res.error}` : `Could not link: ${res.error}`, { position });
		return false;
	}
	refresh();
	const n = res.linked;
	toast.success(
		fr
			? `${n > 1 ? `${n} fils rattachés` : "Rattaché"} à ${res.name}${res.archived.length ? " et archivé" + (res.archived.length > 1 ? "s" : "") : ""}`
			: `${n > 1 ? `${n} conversations linked` : "Linked"} to ${res.name}${res.archived.length ? " and archived" : ""}`,
		{
			position,
			duration: 8000,
			action: {
				label: fr ? "Annuler" : "Undo",
				onClick: () => {
					void undoLinkThreadsToClient(identityPublicId, res.companyId, res.previous, res.archived).then((u) => {
						if (!u.success) {
							toast.error(fr ? "Annulation impossible" : "Could not undo", { position });
							return;
						}
						setLinked(identityPublicId, threadIds, false);
						refresh();
					});
				},
			},
		},
	);
	return true;
}
