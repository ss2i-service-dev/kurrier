// ss2i : agenda Outlook de l'utilisateur (Microsoft Graph), deux semaines par defaut.
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import { outlookCalendarBoxes } from "@/lib/actions/outlook-calendar";
import OutlookAgendaPage from "@/components/outlook-calendar/agenda-page";

export default async function AgendaPage() {
	const [boxes, nouvelle] = await Promise.all([outlookCalendarBoxes(), isNouvelleInterface()]);
	return <OutlookAgendaPage boxes={boxes} nouvelle={nouvelle} />;
}
