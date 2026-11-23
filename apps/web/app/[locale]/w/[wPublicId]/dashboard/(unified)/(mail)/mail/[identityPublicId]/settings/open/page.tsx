import React from "react";
import SettingsOpen from "@/components/mailbox/settings/settings-open";
import { fetchOpenPrefs } from "@/lib/actions/open-prefs";

// Settings > Opening mail (reading tabs, Three-column interface).
async function Page() {
	const prefs = await fetchOpenPrefs();
	return <SettingsOpen initial={prefs} />;
}

export default Page;
