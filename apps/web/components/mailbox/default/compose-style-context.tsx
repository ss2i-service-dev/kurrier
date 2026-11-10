"use client";
import type React from "react";
import { createContext, useContext } from "react";

// The user's "RFC style" and "subject without Re:/Fwd:" options, provided once by the mail
// layout (server side) and read by the editor (preview of the quote above the reply input,
// subject) and by the lists and threads (displayed subject), without passing a prop through
// every page.
const ComposeStyleContext = createContext<{ rfcStyle: boolean; stripSubjectPrefixes: boolean }>({
	rfcStyle: false,
	stripSubjectPrefixes: false,
});

export function ComposeStyleProvider({
	rfcStyle,
	stripSubjectPrefixes = false,
	children,
}: {
	rfcStyle: boolean;
	stripSubjectPrefixes?: boolean;
	children: React.ReactNode;
}) {
	return (
		<ComposeStyleContext.Provider value={{ rfcStyle, stripSubjectPrefixes }}>
			{children}
		</ComposeStyleContext.Provider>
	);
}

export function useRfcStyle() {
	return useContext(ComposeStyleContext).rfcStyle;
}

export function useStripSubjectPrefixes() {
	return useContext(ComposeStyleContext).stripSubjectPrefixes;
}
