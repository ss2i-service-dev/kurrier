"use client";
// Whether the modern interface is active for this user. Provided by the root
// layout (Settings > General > Interface). Lets shared components (editor,
// dialogs...) adapt their rendering to the modern interface without changing
// the classic one (default value: false).
import React, { createContext, useContext } from "react";
import { usePathname } from "next/navigation";
import KNewMailNotifier from "@/components/k/new-mail-notifier";
import KShortcutsConfig from "@/components/k/shortcuts-config";

const KUiContext = createContext(false);

export function KUiProvider({ modern, children }: { modern: boolean; children: React.ReactNode }) {
	// Signed-in pages (workspace) only.
	const inApp = (usePathname() ?? "").includes("/dashboard");
	return (
		<KUiContext.Provider value={modern}>
			{/* New messages: checked every 20 s and the list refreshed (both
			    interfaces); sound and tab badge in the modern interface. */}
			{inApp && <KNewMailNotifier modern={modern} />}
			{/* Custom keyboard shortcuts (Settings > Keyboard shortcuts). */}
			{inApp && <KShortcutsConfig />}
			{children}
		</KUiContext.Provider>
	);
}

/** true in the modern interface, false in the classic one. */
export function useModernUi() {
	return useContext(KUiContext);
}
