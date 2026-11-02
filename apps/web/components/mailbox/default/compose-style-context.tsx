"use client";
import type React from "react";
import { createContext, useContext } from "react";

// ss2i : option « style RFC » de l'utilisateur, fournie une fois par le layout du
// courrier (cote serveur) et lue par l'editeur (apercu de la citation au-dessus de la
// zone de saisie en reponse), sans passer de prop par chaque page.
const ComposeStyleContext = createContext<{ rfcStyle: boolean }>({ rfcStyle: false });

export function ComposeStyleProvider({
	rfcStyle,
	children,
}: {
	rfcStyle: boolean;
	children: React.ReactNode;
}) {
	return (
		<ComposeStyleContext.Provider value={{ rfcStyle }}>
			{children}
		</ComposeStyleContext.Provider>
	);
}

export function useRfcStyle() {
	return useContext(ComposeStyleContext).rfcStyle;
}
