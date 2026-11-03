"use client";
// SS2i : la nouvelle interface est-elle active pour cet utilisateur ? Fourni par
// le layout racine (option Parametres > General > Interface). Permet aux
// composants partages (editeur, fenetres...) d'adapter leur rendu a la nouvelle
// interface sans rien changer a la classique (valeur par defaut : false).
import React, { createContext, useContext } from "react";
import KToastFr from "@/components/k/toast-fr";

const KUiContext = createContext(false);

export function KUiProvider({ nouvelle, children }: { nouvelle: boolean; children: React.ReactNode }) {
	return (
		<KUiContext.Provider value={nouvelle}>
			{/* Outlook : notifications traduites a l'affichage (components/k/toast-fr.tsx) */}
			{nouvelle && <KToastFr />}
			{children}
		</KUiContext.Provider>
	);
}

/** true dans la nouvelle interface, false dans la classique. */
export function useNouvelle() {
	return useContext(KUiContext);
}

/** Texte selon l'interface : anglais d'origine dans la classique, francais dans la nouvelle. */
export function useK() {
	const nouvelle = useContext(KUiContext);
	return (en: string, fr: string) => (nouvelle ? fr : en);
}
