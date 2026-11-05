import { redirect } from "next/navigation";

// URL level without a page (used to be a 404): go to the inbox through the session
// resume route, like the root. Walking up the URL never dead-ends.
export default function Page() {
	redirect("/api/auth/resume");
}
