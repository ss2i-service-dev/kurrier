import { isModernUi } from "@/lib/actions/interface-pref";
import KThreadPage from "@/components/k/thread-page";

// Direct load of a thread URL. Classic interface: nothing here (the thread is
// rendered by threads/[threadId]/page.tsx). Modern interface: the thread goes into
// the reading pane.
export default async function Page(props: { params: Promise<{ identityPublicId: string; mailboxSlug: string; threadId: string }> }) {
	if (!(await isModernUi())) return null;
	return <KThreadPage {...props} />;
}
