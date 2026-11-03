import { notFound, redirect } from "next/navigation";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";

// ss2i : /en (ou /ko) seul. Outlook : on rejoint la boite de reception par la
// route de reprise de session (meme chemin que la racine « / »). Gmail : 404
// comme avant (aucune page n'existait a cette adresse).
export default async function LocaleHome() {
	if (await isNouvelleInterface()) redirect("/api/auth/resume");
	notFound();
}
