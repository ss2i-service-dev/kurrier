import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import KThreadPage from "@/components/k/thread-page";

// ss2i : chargement direct de l'URL d'un fil. Interface classique : rien ici (le
// fil est rendu par threads/[threadId]/page.tsx, comme avant). Nouvelle
// interface : le fil va dans le panneau de lecture.
export default async function Page(props: { params: Promise<{ identityPublicId: string; mailboxSlug: string; threadId: string }> }) {
	if (!(await isNouvelleInterface())) return null;
	return <KThreadPage {...props} />;
}
