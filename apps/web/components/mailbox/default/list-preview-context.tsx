"use client";
import type React from "react";
import { createContext, useContext } from "react";
import type { ListPreviewMode } from "@/lib/actions/list-preview";

// ss2i : option « objet seul » des lignes de liste, fournie une fois par le
// layout du courrier (cote serveur) et lue par les lignes, le panneau des
// non-lus et la recherche, sans passer de prop par chaque page.
const ListPreviewContext = createContext<ListPreviewMode>("subject_snippet");

export function ListPreviewProvider({
	mode,
	children,
}: {
	mode: ListPreviewMode;
	children: React.ReactNode;
}) {
	return (
		<ListPreviewContext.Provider value={mode}>
			{children}
		</ListPreviewContext.Provider>
	);
}

export function useShowSnippet() {
	return useContext(ListPreviewContext) !== "subject";
}
