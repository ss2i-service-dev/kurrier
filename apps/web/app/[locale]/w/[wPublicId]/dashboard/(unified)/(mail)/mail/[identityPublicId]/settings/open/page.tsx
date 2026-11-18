import React from "react";
import SettingsOpen from "@/components/mailbox/settings/settings-open";
import { fetchOpenPrefs } from "@/lib/actions/open-prefs";

// ss2i : Parametres > Ouverture des mails (onglets de lecture, nouvelle interface).
async function Page() {
	const prefs = await fetchOpenPrefs();
	return <SettingsOpen initial={prefs} />;
}

export default Page;
