"use client";
// ss2i (Samuel le 20/11) : l'option « liste sous un fil ouvert », lue une fois par le layout du
// dossier et partagee avec le fil (ThreadSlot) et les listes (dossier, recherche, libelle).
// Mode « hidden » (defaut) : le fil s'ouvre dans un panneau a defilement propre (thread-pane.tsx)
// et la liste reste montee dessous, invisible et inert, sans jamais bouger.
import React, { createContext, useContext, useLayoutEffect, useSyncExternalStore } from "react";
import type { ListUnderThread } from "@/lib/list-under-thread";

const Ctx = createContext<ListUnderThread>("hidden");

export function ListUnderThreadProvider({ mode, children }: { mode: ListUnderThread; children: React.ReactNode }) {
	return <Ctx.Provider value={mode}>{children}</Ctx.Provider>;
}

export function useListUnderThread(): ListUnderThread {
	return useContext(Ctx);
}

// La liste est-elle montee (ListSlot) ? Le panneau du fil ne s'ouvre que par-dessus une liste
// montee : en chargement direct de l'URL d'un fil, l'interface classique rend le fil dans le
// flux (threads/[threadId]/page.tsx) sans liste, et rien ne change pour lui.
let listsMounted = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function useMarkListMounted() {
	useLayoutEffect(() => {
		listsMounted++;
		emit();
		return () => {
			listsMounted--;
			emit();
		};
	}, []);
}

export function useListMounted(): boolean {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => listsMounted > 0,
		() => false,
	);
}
