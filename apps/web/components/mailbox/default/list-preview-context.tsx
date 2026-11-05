"use client";
import type React from "react";
import { createContext, useContext } from "react";
import type { ListPreviewMode } from "@/lib/actions/list-preview";

// "Subject only" option of the list rows, provided once by the mail layout
// (server side) and read by the rows, the unread panel and the search, without
// passing a prop through every page.
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
