import React from "react";
import SettingsShortcuts from "@/components/mailbox/settings/settings-shortcuts";
import { fetchShortcutPrefs } from "@/lib/actions/shortcuts";

// Settings > Keyboard shortcuts (both interfaces).
async function Page() {
	const prefs = await fetchShortcutPrefs();
	return <SettingsShortcuts initial={prefs} />;
}

export default Page;
