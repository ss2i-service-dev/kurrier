import { notFound, redirect } from "next/navigation";
import { isModernUi } from "@/lib/actions/interface-pref";

// Bare /en (or /ko). Modern interface: go to the inbox through the session resume
// route (same path as the root "/"). Classic interface: 404, as no page existed
// at this address.
export default async function LocaleHome() {
	if (await isModernUi()) redirect("/api/auth/resume");
	notFound();
}
