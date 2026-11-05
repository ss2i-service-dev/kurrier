import { isSignedIn } from "@/lib/actions/auth";
import { redirect } from "next/navigation";

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await isSignedIn();

	if (user) {
		// The old target /dashboard/platform/overview lacked the /w/<id>/ segment
		// and returned a 404 whenever a session was still valid.
		redirect("/api/auth/resume");
	}

	return <>{children}</>;
}
