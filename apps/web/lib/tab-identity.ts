// ss2i : titre et icone de l'onglet par section, pour reconnaitre d'un coup d'oeil un onglet
// de mail d'un onglet de calendrier (Samuel le 06/11). Tous les onglets s'appelaient
// « Kurrier » avec la meme icone. Les sections sans icone gardent le favicon de l'application.
import type { Metadata } from "next";

export const TAB_SECTIONS = {
	mail: { title: "Courrier", icon: "/tab-icons/mail.svg" },
	calendar: { title: "Calendrier", icon: "/tab-icons/calendar.svg" },
	agenda: { title: "Agenda", icon: "/tab-icons/calendar.svg" },
	contacts: { title: "Contacts", icon: null },
	drive: { title: "Fichiers", icon: null },
	platform: { title: "Plateforme", icon: null },
} as const;

export type TabSection = keyof typeof TAB_SECTIONS;

// Section d'apres le chemin (/en/w/<ws>/dashboard/agenda, .../mail/<identite>/<dossier>...).
export function tabSectionOf(pathname: string): TabSection {
	const parts = pathname.split("/").filter(Boolean);
	for (const s of ["agenda", "calendar", "contacts", "drive", "platform"] as const) {
		if (parts.includes(s)) return s;
	}
	return "mail";
}

const MAIL_FOLDER_TITLES: Record<string, string> = {
	inbox: "Boîte de réception",
	sent: "Envoyés",
	drafts: "Brouillons",
	archive: "Archives",
	spam: "Spam",
	trash: "Corbeille",
	snoozed: "Reportés",
	scheduled: "Programmés",
	clients: "Clients",
	settings: "Paramètres",
};

// Titre tenu a jour par la nouvelle interface (components/k/new-mail-notifier.tsx) :
// « (3) Courrier - Boîte de réception » dans le mail, « Agenda » ou « Calendrier » ailleurs,
// sans compteur de non lus hors du mail. folderLabel : nom d'un dossier personnel.
export function tabTitle(pathname: string, unread: number, folderLabel?: string | null): string {
	const section = tabSectionOf(pathname);
	const name = TAB_SECTIONS[section].title;
	if (section !== "mail") return name;
	const parts = pathname.split("/").filter(Boolean);
	const i = parts.indexOf("mail");
	const slug = i >= 0 ? parts[i + 2] : undefined;
	const folder = !slug
		? null
		: parts[i + 3] === "search"
			? "Recherche"
			: MAIL_FOLDER_TITLES[slug] ?? (folderLabel?.trim() || null);
	const base = folder ? `${name} - ${folder}` : name;
	return unread > 0 ? `(${unread}) ${base}` : base;
}

export function tabMetadata(section: TabSection): Metadata {
	const { title, icon } = TAB_SECTIONS[section];
	if (!icon) return { title };
	return { title, icons: { icon: [{ url: icon, type: "image/svg+xml" }] } };
}
