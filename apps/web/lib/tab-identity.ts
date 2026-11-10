// Title and icon of the browser tab per section, to tell a mail tab from a calendar tab at a
// glance. Every tab used to be called "Kurrier" with the same icon. Sections without an icon
// keep the favicon of the application.
import type { Metadata } from "next";

export const TAB_SECTIONS = {
	mail: { title: "Mail", icon: "/tab-icons/mail.svg" },
	calendar: { title: "Calendar", icon: "/tab-icons/calendar.svg" },
	contacts: { title: "Contacts", icon: null },
	drive: { title: "Drive", icon: null },
	platform: { title: "Platform", icon: null },
} as const;

export type TabSection = keyof typeof TAB_SECTIONS;

// Section from the path (/en/w/<ws>/dashboard/calendar, .../mail/<identity>/<folder>...).
export function tabSectionOf(pathname: string): TabSection {
	const parts = pathname.split("/").filter(Boolean);
	for (const s of ["calendar", "contacts", "drive", "platform"] as const) {
		if (parts.includes(s)) return s;
	}
	return "mail";
}

const MAIL_FOLDER_TITLES: Record<string, string> = {
	inbox: "Inbox",
	sent: "Sent",
	drafts: "Drafts",
	archive: "Archive",
	spam: "Spam",
	trash: "Trash",
	snoozed: "Snoozed",
	scheduled: "Scheduled",
	settings: "Settings",
};

// Title kept up to date by the modern interface (components/k/new-mail-notifier.tsx):
// "(3) Mail - Inbox" in the mail, the section name elsewhere, without an unread count outside
// the mail. folderLabel: name of a custom folder.
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
			? "Search"
			: MAIL_FOLDER_TITLES[slug] ?? (folderLabel?.trim() || null);
	const base = folder ? `${name} - ${folder}` : name;
	return unread > 0 ? `(${unread}) ${base}` : base;
}

export function tabMetadata(section: TabSection): Metadata {
	const { title, icon } = TAB_SECTIONS[section];
	if (!icon) return { title };
	return { title, icons: { icon: [{ url: icon, type: "image/svg+xml" }] } };
}
