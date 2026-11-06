import { SidebarProvider } from "@/components/ui/sidebar";
import {fetchWorkspace} from "@/lib/actions/workspace";
import MeetingAlerts from "@/components/outlook-calendar/meeting-alerts";
import { fetchChangelogs } from "@/lib/actions/changelogs";
import { WhatsNewProvider } from "@/components/common/whats-new";

export default async function DashboardLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const workspace = await fetchWorkspace();
	// ss2i (OI 10363) : modale « Nouveautes », bouton dans la barre laterale des deux interfaces.
	const { entries, lastSeen } = await fetchChangelogs();
	return (
		<WhatsNewProvider entries={entries} lastSeen={lastSeen}>
		{workspace?.isStorageOverLimit && <div className={" bg-red-100 w-full mb-4 rounded text-center z-10 text-sm text-red-700 p-2"}>
				Your account is on hold. Please upgrade your workspace storage limit.
			</div>}

			<SidebarProvider
				style={
					{
						"--sidebar-width": "250px",
					} as React.CSSProperties
				}
				className={"sidebar-animation"}
			>
				{children}
			</SidebarProvider>
			{/* ss2i : rappels des reunions de l'agenda Outlook dans tout courrier (bandeau en haut) */}
			<MeetingAlerts />
		</WhatsNewProvider>
	);
}
