"use client";
// SS2i : la nouvelle interface est-elle active pour cet utilisateur ? Fourni par
// le layout racine (option Parametres > General > Interface). Permet aux
// composants partages (editeur, fenetres...) d'adapter leur rendu a la nouvelle
// interface sans rien changer a la classique (valeur par defaut : false).
import React, { createContext, useContext } from "react";
import { usePathname } from "next/navigation";
import KToastFr from "@/components/k/toast-fr";
import KNewMailNotifier from "@/components/k/new-mail-notifier";
import KShortcutsConfig from "@/components/k/shortcuts-config";

const KUiContext = createContext(false);

export function KUiProvider({ nouvelle, children }: { nouvelle: boolean; children: React.ReactNode }) {
	// ss2i : pages connectees (espace de travail) seulement.
	const inApp = (usePathname() ?? "").includes("/dashboard");
	return (
		<KUiContext.Provider value={nouvelle}>
			{/* Outlook : notifications traduites a l'affichage (components/k/toast-fr.tsx) */}
			{nouvelle && <KToastFr />}
			{/* Nouveaux messages : verification toutes les 20 s et liste actualisee
			    (les deux interfaces) ; son et pastille sur l'onglet en Outlook. */}
			{inApp && <KNewMailNotifier nouvelle={nouvelle} />}
			{/* Raccourcis clavier personnalises (Parametres > Raccourcis clavier). */}
			{inApp && <KShortcutsConfig nouvelle={nouvelle} />}
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
