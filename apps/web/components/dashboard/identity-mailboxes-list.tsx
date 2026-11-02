"use client";

import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { cn, setSidebarWidth } from "@/lib/utils";
import {
	Inbox,
	Send,
	FileText,
	Archive,
	Ban,
	Trash2,
	Folder,
	ChevronRight,
	ChevronDown,
	MoreVertical,
	Clock4,
	Building2,
} from "lucide-react";
import * as React from "react";
import { Suspense, use, useEffect } from "react";
import {
	FetchIdentityMailboxListResult,
	FetchMailboxUnreadCountsResult,
} from "@/lib/actions/mailbox";
import { MailboxKind } from "@schema";
import {
	DraftMessageEntity,
	IdentityEntity,
	MailboxEntity,
	MailboxThreadEntity,
} from "@db";
import AddNewFolder from "@/components/mailbox/default/add-new-folder";
import { Menu, Select } from "@mantine/core";
import DeleteMailboxFolder from "@/components/mailbox/default/delete-folder";
import { setIdentityCollapsed } from "@/lib/actions/collapsed-identities";
import type { IdentityClients as IdentityClientsData } from "@/lib/actions/thread-clients";
import { IconMailFast } from "@tabler/icons-react";

const ORDER: MailboxKind[] = [
	"inbox",
	"drafts",
	"sent",
	"archive",
	"spam",
	"trash",
	"outbox",
	"custom",
];

const ICON: Record<MailboxKind, React.ElementType> = {
	inbox: Inbox,
	sent: Send,
	drafts: FileText,
	archive: Archive,
	spam: Ban,
	trash: Trash2,
	outbox: Send,
	custom: Folder,
};

const TITLE: Record<MailboxKind, string> = {
	inbox: "Inbox",
	sent: "Sent",
	drafts: "Drafts",
	archive: "Archive",
	spam: "Spam",
	trash: "Trash",
	outbox: "Outbox",
	custom: "Mailbox",
};

type TreeMailbox = {
	id: string;
	name: string | null;
	kind: MailboxKind;
	slug: string | null;
	parentId: string | null;
	selectable: boolean;
	unread: number;
	children: TreeMailbox[];
};

function buildTree(
	rows: MailboxEntity[],
	unreadCounts: FetchMailboxUnreadCountsResult,
): TreeMailbox[] {
	const byId = new Map<string, TreeMailbox>();
	const roots: TreeMailbox[] = [];

	for (const r of rows) {
		byId.set(r.id, {
			id: r.id,
			name: r.name ?? null,
			kind: r.kind as MailboxKind,
			slug: r.slug ?? null,
			parentId: (r as any).parentId ?? null,
			selectable: (r.metaData as any)?.imap?.selectable !== false,
			unread: unreadCounts.get(r.id)?.unreadTotal ?? 0,
			children: [],
		});
	}

	for (const node of byId.values()) {
		if (node.parentId && byId.has(node.parentId)) {
			byId.get(node.parentId)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	const sortRec = (arr: TreeMailbox[]) => {
		arr.sort(
			(a, b) =>
				(ORDER.indexOf(a.kind) ?? 999) - (ORDER.indexOf(b.kind) ?? 999) ||
				(a.name ?? "").localeCompare(b.name ?? ""),
		);
		for (const c of arr) if (c.children.length) sortRec(c.children);
	};
	sortRec(roots);

	return roots;
}

function IdentityExtraCounts({
								 identity,
								 scheduledDraftsPromise,
								 snoozedThreadsPromise,
								 workspacePublicId,
								 currentSlug,
							 }: {
	identity: IdentityEntity;
	scheduledDraftsPromise: Promise<DraftMessageEntity[]>;
	snoozedThreadsPromise: Promise<{ threads: MailboxThreadEntity[] }>;
	workspacePublicId: string | undefined;
	currentSlug: string;
}) {
	const scheduledDrafts = use(scheduledDraftsPromise);
	const { threads: snoozedThreads } = use(snoozedThreadsPromise);

	const scheduledCount = scheduledDrafts.filter(
		(d) => d.identityId === identity.id,
	).length;

	const snoozedCount = snoozedThreads.filter(
		(s) => s.identityId === identity.id,
	).length;

	return (
		<>
			{scheduledCount > 0 && (
				<Link
					href={`/w/${workspacePublicId}/dashboard/mail/${identity.publicId}/scheduled`}
					className={`my-2 rounded hover:dark:bg-neutral-800 ${
						currentSlug === "scheduled"
							? "dark:bg-neutral-800 dark:text-brand-foreground bg-brand-200 text-brand"
							: ""
					} flex justify-start gap-1 w-full p-1.5`}
				>
					<IconMailFast size={22} />
					<span className="font-normal text-sm">
						Scheduled ({scheduledCount})
					</span>
				</Link>
			)}

			{snoozedCount > 0 && (
				<Link
					href={`/w/${workspacePublicId}/dashboard/mail/${identity.publicId}/snoozed`}
					className={`mx-1.5 my-2 rounded hover:dark:bg-neutral-800 ${
						currentSlug === "snoozed"
							? "dark:bg-neutral-800 dark:text-brand-foreground bg-brand-200 text-brand"
							: ""
					} flex justify-start gap-1 w-full p-1.5 items-center`}
				>
					<Clock4 size={16} />
					<span className="font-normal text-sm">
						Snoozed ({snoozedCount})
					</span>
				</Link>
			)}
		</>
	);
}

// ss2i : section « Clients » d'une identite pro : un dossier virtuel par societe de la
// CRM, derniere activite en premier, nombre de fils entre parentheses (pas de non lus :
// rien a annoncer). Au-dela de SIDEBAR_CLIENTS, un champ filtre la liste complete.
const SIDEBAR_CLIENTS = 20;

function IdentityClients({
	identity,
	clientsPromise,
	workspacePublicId,
	pathname,
}: {
	identity: IdentityEntity;
	clientsPromise: Promise<IdentityClientsData[]>;
	workspacePublicId: string | undefined;
	pathname: string;
}) {
	const all = use(clientsPromise);
	const entry = all.find((e) => e.identityId === identity.id);
	const [filter, setFilter] = React.useState("");
	if (!entry || entry.clients.length === 0) return null;

	const base = `/w/${workspacePublicId}/dashboard/mail/${identity.publicId}/clients`;
	const needle = filter.trim().toLowerCase();
	const shown = (needle ? entry.clients.filter((c) => c.name.toLowerCase().includes(needle)) : entry.clients).slice(
		0,
		SIDEBAR_CLIENTS,
	);
	const isIndex = pathname === base;

	return (
		<div className="mt-2">
			<Link
				href={base}
				className={`px-1 mb-1 text-xs font-semibold flex items-center gap-1 hover:text-sidebar-foreground ${
					isIndex ? "text-sidebar-foreground" : "text-sidebar-foreground/60"
				}`}
				title="All clients"
			>
				<Building2 className="h-3.5 w-3.5 shrink-0" />
				<span>Clients ({entry.clients.length})</span>
			</Link>
			{entry.clients.length > SIDEBAR_CLIENTS && (
				<input
					type="text"
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder="Filter clients"
					className="mx-1.5 my-1 w-[calc(100%-12px)] rounded border bg-transparent px-2 py-1 text-xs outline-none focus:border-brand"
				/>
			)}
			<div className="space-y-0.5">
				{shown.map((c) => {
					const href = `${base}/${c.companyId}`;
					const active = pathname === href || pathname.startsWith(`${href}/`);
					return (
						<Link
							key={c.companyId}
							href={href}
							title={c.name}
							className={`mx-1.5 rounded hover:dark:bg-neutral-800 ${
								active ? "dark:bg-neutral-800 dark:text-brand-foreground bg-brand-200 text-brand" : ""
							} flex items-center gap-1 w-full p-1.5 pl-2`}
						>
							<span className="truncate font-normal text-sm">{c.name}</span>
							<span className="ml-auto shrink-0 text-xs text-sidebar-foreground/60">{c.threadCount}</span>
						</Link>
					);
				})}
				{needle && shown.length === 0 && (
					<div className="px-2 py-1 text-xs text-sidebar-foreground/60">No client matches</div>
				)}
				{!needle && entry.clients.length > SIDEBAR_CLIENTS && (
					<Link href={base} className="mx-1.5 block p-1.5 pl-2 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground">
						All clients ({entry.clients.length})
					</Link>
				)}
			</div>
		</div>
	);
}

export default function IdentityMailboxesList({
												  identityMailboxes,
												  unreadCounts,
												  scheduledDraftsPromise,
												  snoozedThreadsPromise,
												  clientsPromise,
												  workspacePublicId,
												  initialCollapsed = [],
												  onComplete,
											  }: {
	identityMailboxes: FetchIdentityMailboxListResult;
	unreadCounts: FetchMailboxUnreadCountsResult;
	scheduledDraftsPromise: Promise<DraftMessageEntity[]>;
	snoozedThreadsPromise: Promise<{ threads: MailboxThreadEntity[] }>;
	// ss2i : clients (CRM) des identites pro, section sous les dossiers.
	clientsPromise?: Promise<IdentityClientsData[]>;
	workspacePublicId: string | undefined;
	// ss2i : publicId des identites repliees (preference serveur par utilisateur).
	initialCollapsed?: string[];
	onComplete?: () => void;
}) {
	// ss2i : boite repliee = seulement son nom et le nombre de non lus de l'Inbox.
	const [collapsed, setCollapsed] = React.useState<Set<string>>(
		() => new Set(initialCollapsed),
	);
	const toggleIdentity = React.useCallback((publicId: string) => {
		setCollapsed((prev) => {
			const next = new Set(prev);
			const nowCollapsed = !next.has(publicId);
			if (nowCollapsed) next.add(publicId);
			else next.delete(publicId);
			void setIdentityCollapsed(publicId, nowCollapsed);
			return next;
		});
	}, []);
	const pathname = usePathname();
	const params = useParams() as {
		identityPublicId?: string;
		mailboxSlug?: string;
	};

	useEffect(() => {
		setSidebarWidth("290px");
		return () => setSidebarWidth("250px");
	}, []);

	const currentSlug = React.useMemo(() => {
		const parts = pathname.split("/").filter(Boolean);
		return parts.at(-1) ?? "inbox";
	}, [pathname]);

	const router = useRouter()

	const Item = ({
					  m,
					  identityPublicId,
					  identity,
					  level = 0,
				  }: {
		m: TreeMailbox;
		identityPublicId: string;
		identity: IdentityEntity;
		level?: number;
	}) => {
		const Icon = ICON[m.kind] ?? Folder;
		const slug = m.slug ?? "inbox";
		const href = `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${slug}`;

		const isActive =
			pathname === href ||
			(params.identityPublicId === identityPublicId && currentSlug === slug);

		const [open, setOpen] = React.useState(true);
		const hasChildren = m.children.length > 0;

		return (
			<div>
				<div className="flex items-center">
					{hasChildren ? (
						<button
							type="button"
							onClick={() => setOpen((v) => !v)}
							className="mr-1 rounded p-0.5 hover:bg-sidebar-accent/60"
							aria-label={open ? "Collapse" : "Expand"}
						>
							{open ? (
								<ChevronDown className="h-3.5 w-3.5" />
							) : (
								<ChevronRight className="h-3.5 w-3.5" />
							)}
						</button>
					) : (
						<span className="w-4" />
					)}

					<div className="flex w-full items-start">
						<Link
							href={href}
							onClick={onComplete ? () => onComplete() : undefined}
							aria-disabled={!m.selectable}
							className={cn(
								"flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pl-2 text-sm",
								"hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
								isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
								isActive
									? "text-brand dark:text-white bg-brand-100 dark:bg-neutral-800 hover:text-brand hover:bg-brand-100"
									: "",
								!m.selectable &&
								"opacity-60 pointer-events-none cursor-default",
							)}
							style={{ paddingLeft: 8 + level * 8 }}
						>
							<Icon className="h-4 w-4 shrink-0" />
							<span className="truncate">
								{m.kind === "custom" ? (m.name ?? "Mailbox") : TITLE[m.kind]}
								{m.unread > 0 && <span> ({m.unread})</span>}
							</span>
						</Link>

						{m.kind === "custom" && (
							<Menu withinPortal position="right-start" offset={4}>
								<Menu.Target>
									<button
										type="button"
										onClick={(e) => e.stopPropagation()}
										className={cn(
											"rounded p-1 mt-1.25 transition",
											"hover:bg-sidebar-accent/60",
										)}
										aria-label={`Actions for ${m.name ?? "folder"}`}
									>
										<MoreVertical className="h-4 w-4" />
									</button>
								</Menu.Target>

								<Menu.Dropdown onClick={(e) => e.stopPropagation()}>
									<DeleteMailboxFolder
										mailboxId={m.id}
										identityPublicId={identityPublicId}
										imapOp={!!identity.smtpAccountId}
									/>
								</Menu.Dropdown>
							</Menu>
						)}
					</div>
				</div>

				{open && hasChildren && (
					<div>
						{m.children.map((child) => (
							<Item
								key={child.id}
								m={child}
								identityPublicId={identityPublicId}
								identity={identity}
								level={level + 1}
							/>
						))}
					</div>
				)}
			</div>
		);
	};

	return (
		<div className="space-y-2 px-2">
			<div className={"my-2"}>
				<Select placeholder="Pick value"
				        size={"xs"}
				        onChange={(publicId) => {
							router.push(`/w/${workspacePublicId}/dashboard/mail/${publicId}/inbox`)
						}}
				        value={params.identityPublicId}
				        data={identityMailboxes.map((id) => {
							return {value: id.identity.publicId, label: id.identity.value}
						})} />
			</div>

			{identityMailboxes.map(({ identity, mailboxes }) => {
				const tree = buildTree(mailboxes as MailboxEntity[], unreadCounts);

				const isCollapsed = collapsed.has(identity.publicId);
				const inboxUnread = tree.find((m) => m.kind === "inbox")?.unread ?? 0;

				return (
					<div key={identity.id}>
						<div className="px-1 mb-1 mt-2 text-xs font-semibold text-sidebar-foreground/60 flex items-center gap-1">
							<button
								type="button"
								onClick={() => toggleIdentity(identity.publicId)}
								className="flex items-center gap-1 min-w-0 hover:text-sidebar-foreground"
								aria-expanded={!isCollapsed}
								title={isCollapsed ? "Expand mailbox" : "Collapse mailbox"}
							>
								{isCollapsed ? (
									<ChevronRight className="h-3.5 w-3.5 shrink-0" />
								) : (
									<ChevronDown className="h-3.5 w-3.5 shrink-0" />
								)}
								<span className="truncate">{identity.value}</span>
								{isCollapsed && inboxUnread > 0 && (
									<span className="shrink-0">({inboxUnread})</span>
								)}
							</button>
							{!isCollapsed && <AddNewFolder mailboxes={mailboxes} identity={identity} />}
						</div>

						{!isCollapsed && (<>
						<div className="space-y-1">
							{tree.map((m) => (
								<Item
									key={`${identity.id}:${m.id}`}
									m={m}
									identityPublicId={identity.publicId}
									identity={identity}
								/>
							))}
						</div>

						<Suspense fallback={null}>
							<IdentityExtraCounts
								identity={identity}
								scheduledDraftsPromise={scheduledDraftsPromise}
								snoozedThreadsPromise={snoozedThreadsPromise}
								workspacePublicId={workspacePublicId}
								currentSlug={currentSlug}
							/>
						</Suspense>

						{clientsPromise && (
							<Suspense fallback={null}>
								<IdentityClients
									identity={identity}
									clientsPromise={clientsPromise}
									workspacePublicId={workspacePublicId}
									pathname={pathname}
								/>
							</Suspense>
						)}
						</>)}
					</div>
				);
			})}
		</div>
	);
}
