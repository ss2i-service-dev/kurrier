import React from "react";
import SettingsShortcuts from "@/components/mailbox/settings/settings-shortcuts";
import { fetchShortcutPrefs } from "@/lib/actions/shortcuts";

// ss2i : Parametres > Raccourcis clavier (les deux interfaces).
async function Page() {
	const prefs = await fetchShortcutPrefs();
	return <SettingsShortcuts initial={prefs} />;
}

export default Page;
