import { isSignedIn } from "@/lib/actions/auth";
import { redirect } from "next/navigation";

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await isSignedIn();

	if (user) {
		// ss2i : l'amont visait /dashboard/platform/overview, sans le segment
		// /w/<id>/ : 404 a chaque ouverture avec une session encore valide.
		redirect("/api/auth/resume");
	}

	return <>{children}</>;
}
