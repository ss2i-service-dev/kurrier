"use client";
// Mailbox shell. A single sidebar (account, new message, folders, labels, other
// areas), then the work area on the right. On mobile, the sidebar becomes a
// drawer opened from the list header.
import React, { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { Drawer, Menu } from "@mantine/core";
import {
	Calendar,
	Check,
	ChevronsUpDown,
	Contact,
	HardDrive,
	LayoutGrid,
	LogOut,
	Mail,
	Monitor,
	Moon,
	Settings,
	Sun,
	Undo2,
	Volume2,
	VolumeX,
} from "lucide-react";
import { setNewMailSound, useNewMailSound } from "@/components/k/new-mail-notifier";
import KAvatar from "@/components/k/avatar";
import { useAppearance } from "@/components/providers/appearance-provider";
import { signOut } from "@/lib/actions/auth";
import { switchWorkSpace } from "@/lib/actions/workspace";
import { setInterfaceMode } from "@/lib/actions/interface-pref";

type Identity = { publicId: string; value: string; displayName?: string | null };
type Workspace = { publicId: string; id: string; name: string };

const ShellContext = createContext<{ openNav: () => void }>({ openNav: () => {} });
export const useMailShell = () => useContext(ShellContext);

export default function KMailShell({
	workspacePublicId,
	identities,
	workspaces,
	userEmail,
	compose,
	nav,
	children,
}: {
	workspacePublicId?: string;
	identities: Identity[];
	workspaces: Workspace[];
	userEmail?: string | null;
	compose: React.ReactNode;
	nav: React.ReactNode;
	children: React.ReactNode;
}) {
	const [navOpen, setNavOpen] = useState(false);
	const pathname = usePathname();
	useEffect(() => setNavOpen(false), [pathname]);

	const sidebar = (
		<SidebarContent
			workspacePublicId={workspacePublicId}
			identities={identities}
			workspaces={workspaces}
			userEmail={userEmail}
			compose={compose}
			nav={nav}
		/>
	);

	return (
		<ShellContext.Provider value={{ openNav: () => setNavOpen(true) }}>
			<div className="k-root flex h-svh w-full overflow-hidden bg-k-canvas text-k-ink">
				<aside className="hidden w-[248px] shrink-0 flex-col md:flex">{sidebar}</aside>
				<Drawer
					opened={navOpen}
					onClose={() => setNavOpen(false)}
					size={290}
					withCloseButton={false}
					padding={0}
					styles={{ body: { height: "100%", background: "var(--k-canvas)" } }}
				>
					{/* mobile drawer: no "new message" button (already at the bottom of the list) */}
					<div className="flex h-full flex-col">
						<SidebarContent
							workspacePublicId={workspacePublicId}
							identities={identities}
							workspaces={workspaces}
							userEmail={userEmail}
							compose={null}
							nav={nav}
						/>
					</div>
				</Drawer>
				<main className="flex min-w-0 flex-1 md:py-2 md:pr-2">{children}</main>
			</div>
		</ShellContext.Provider>
	);
}

function SidebarContent({
	workspacePublicId,
	identities,
	workspaces,
	userEmail,
	compose,
	nav,
}: {
	workspacePublicId?: string;
	identities: Identity[];
	workspaces: Workspace[];
	userEmail?: string | null;
	compose: React.ReactNode;
	nav: React.ReactNode;
}) {
	const params = useParams() as { identityPublicId?: string };
	const router = useRouter();
	const pathname = usePathname() ?? "";
	const { mode, setMode } = useAppearance();
	const current = identities.find((i) => i.publicId === params.identityPublicId) ?? identities[0];
	const currentWs = workspaces.find((w) => w.publicId === workspacePublicId);
	const base = `/w/${workspacePublicId}/dashboard`;

	const apps = [
		{ href: `${base}/mail`, label: "Mail", icon: Mail, match: "/mail" },
		{ href: `${base}/calendar`, label: "Calendar", icon: Calendar, match: "/calendar" },
		{ href: `${base}/contacts`, label: "Contacts", icon: Contact, match: "/contacts" },
		{ href: `${base}/drive`, label: "Drive", icon: HardDrive, match: "/drive" },
		{ href: `${base}/platform/overview`, label: "Platform", icon: LayoutGrid, match: "/platform" },
	];

	return (
		<div className="flex h-full min-h-0 flex-col px-3 pb-3 pt-3">
			{/* Account */}
			<Menu position="bottom-start" width={268} offset={6} shadow="none" radius={12}>
				<Menu.Target>
					<button
						type="button"
						className="k-focus mb-3 flex w-full items-center gap-2.5 rounded-k px-2 py-1.5 text-left transition-colors hover:bg-k-hover"
					>
						<KAvatar name={current?.displayName || userEmail} email={current?.value ?? userEmail} size={30} />
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[13.5px] font-semibold leading-tight text-k-ink">
								{currentWs?.name ?? "Mail"}
							</span>
							<span className="block truncate text-[12px] leading-tight text-k-ink-3">{current?.value ?? userEmail}</span>
						</span>
						<ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-k-ink-3" />
					</button>
				</Menu.Target>
				<Menu.Dropdown className="!border-0 !p-1.5 shadow-k-pop">
					{identities.length > 0 && <Menu.Label>Addresses</Menu.Label>}
					{identities.map((i) => (
						<Menu.Item
							key={i.publicId}
							leftSection={<KAvatar name={i.displayName} email={i.value} size={22} />}
							rightSection={i.publicId === current?.publicId ? <Check size={14} /> : null}
							onClick={() => router.push(`${base}/mail/${i.publicId}/inbox`)}
						>
							<span className="text-[13px]">{i.value}</span>
						</Menu.Item>
					))}
					{workspaces.length > 1 && (
						<>
							<Menu.Divider />
							<Menu.Label>Workspaces</Menu.Label>
							{workspaces.map((w) => (
								<Menu.Item
									key={w.id}
									rightSection={w.publicId === workspacePublicId ? <Check size={14} /> : null}
									onClick={() => switchWorkSpace(w.publicId, w.id)}
								>
									<span className="text-[13px]">{w.name}</span>
								</Menu.Item>
							))}
						</>
					)}
					<Menu.Divider />
					<Menu.Label>Appearance</Menu.Label>
					<div className="mx-1 mb-1 grid grid-cols-3 gap-1 rounded-k-sm bg-k-hover p-0.5">
						{(
							[
								["light", "Light", Sun],
								["dark", "Dark", Moon],
								["system", "Auto", Monitor],
							] as const
						).map(([m, label, Icon]) => (
							<button
								key={m}
								type="button"
								onClick={() => setMode(m)}
								className={`flex items-center justify-center gap-1 rounded-[5px] py-1 text-[12px] transition-colors ${
									mode === m ? "bg-k-surface font-medium text-k-ink shadow-k-pane" : "text-k-ink-2 hover:text-k-ink"
								}`}
							>
								<Icon size={13} />
								{label}
							</button>
						))}
					</div>
					<Menu.Divider />
					{current && (
						<Menu.Item
							leftSection={<Settings size={15} />}
							onClick={() => router.push(`${base}/mail/${current.publicId}/settings`)}
						>
							<span className="text-[13px]">Address settings</span>
						</Menu.Item>
					)}
					<SoundToggle />
					<Menu.Item
						leftSection={<Undo2 size={15} />}
						onClick={async () => {
							await setInterfaceMode("classic");
							window.location.reload();
						}}
					>
						<span className="text-[13px]">Switch to the classic interface</span>
					</Menu.Item>
					<Menu.Item leftSection={<LogOut size={15} />} color="red" onClick={() => signOut()}>
						<span className="text-[13px]">Sign out</span>
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>

			<div className="mb-4">{compose}</div>

			<div className="k-scroll -mx-1 min-h-0 flex-1 overflow-y-auto px-1">{nav}</div>

			{/* Other areas */}
			<div className="mt-3 flex items-center gap-1 border-t border-k-line pt-3">
				{apps.map(({ href, label, icon: Icon, match }) => {
					const active = pathname.includes(match);
					return (
						<Link
							key={href}
							href={href}
							title={label}
							className={`flex flex-1 flex-col items-center gap-0.5 rounded-k-sm py-1.5 text-[11px] transition-colors ${
								active ? "bg-k-surface text-k-ink shadow-k-pane" : "text-k-ink-3 hover:bg-k-hover hover:text-k-ink"
							}`}
						>
							<Icon size={16} />
							{label}
						</Link>
					);
				})}
			</div>
		</div>
	);
}

/** Account menu: sound when a message arrives (preference kept per browser). */
function SoundToggle() {
	const on = useNewMailSound();
	return (
		<Menu.Item
			closeMenuOnClick={false}
			leftSection={on ? <Volume2 size={15} /> : <VolumeX size={15} />}
			rightSection={on ? <Check size={14} className="text-k-accent" /> : null}
			onClick={() => setNewMailSound(!on)}
		>
			<span className="text-[13px]">New message sound</span>
		</Menu.Item>
	);
}
