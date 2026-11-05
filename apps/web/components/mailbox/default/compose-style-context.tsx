"use client";
import type React from "react";
import { createContext, useContext } from "react";

// The user's "RFC style" option, provided once by the mail layout (server side) and read
// by the editor (preview of the quote above the reply input), without passing a prop
// through every page.
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
