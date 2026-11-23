"use client";
// Whether the modern interface is active for this user. Provided by the root
// layout (Settings > General > Interface). Lets shared components (editor,
// dialogs...) adapt their rendering to the modern interface without changing
// the classic one (default value: false).
import React, { createContext, useContext } from "react";
import { usePathname } from "next/navigation";
import KNewMailNotifier from "@/components/k/new-mail-notifier";
import KShortcutsConfig from "@/components/k/shortcuts-config";
import { KOpenPrefsConfig } from "@/components/k/reader-tabs-bar";

const KUiContext = createContext(false);
// Times in 24-hour format (Settings > General, pref24HourTime), read by the root layout.
const KHour24Context = createContext(false);

export function KUiProvider({
	modern,
	hour24 = false,
	children,
}: {
	modern: boolean;
	hour24?: boolean;
	children: React.ReactNode;
}) {
	// Signed-in pages (workspace) only.
	const inApp = (usePathname() ?? "").includes("/dashboard");
	return (
		<KUiContext.Provider value={modern}>
			<KHour24Context.Provider value={hour24}>
			{/* New messages: checked every 20 s and the list refreshed (both
			    interfaces); sound and tab badge in the modern interface. */}
			{inApp && <KNewMailNotifier modern={modern} />}
			{/* Custom keyboard shortcuts (Settings > Keyboard shortcuts). */}
			{inApp && <KShortcutsConfig />}
			{/* Thread opening: internal tabs (Settings > Opening mail). */}
			{inApp && modern && <KOpenPrefsConfig />}
			{children}
			</KHour24Context.Provider>
		</KUiContext.Provider>
	);
}

/** true in the modern interface, false in the classic one. */
export function useModernUi() {
	return useContext(KUiContext);
}

/** true when times are shown in 24-hour format (pref24HourTime), false for the locale default. */
export function useHour24() {
	return useContext(KHour24Context);
}
