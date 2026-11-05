"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
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
} from "lucide-react";
import * as React from "react";
import { Suspense, use, useEffect } from "react";
import { syncServerCounts, useMailStore } from "@/components/k/mail-store";
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
import AddNewFolder from "@/components/k/add-folder";
import { Menu } from "@mantine/core";
import DeleteMailboxFolder from "@/components/k/delete-folder";
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
	custom: "Folder",
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
			// unread threads (like the list), not unread messages
			unread: unreadCounts.get(r.id)?.unreadThreads ?? 0,
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

	const linkCls = (active: boolean) =>
		cn(
			"flex items-center gap-2.5 rounded-k-sm px-2.5 py-[7px] text-[13.5px] transition-colors",
			active ? "bg-k-surface font-medium text-k-ink shadow-k-pane" : "text-k-ink-2 hover:bg-k-hover hover:text-k-ink",
		);
	return (
		<>
			{scheduledCount > 0 && (
				<Link
					href={`/w/${workspacePublicId}/dashboard/mail/${identity.publicId}/scheduled`}
					className={linkCls(currentSlug === "scheduled")}
				>
					<IconMailFast size={16} className="shrink-0 text-k-ink-3" />
					<span className="flex-1 truncate">Scheduled sends</span>
					<span className="text-[12px] tabular-nums text-k-ink-3">{scheduledCount}</span>
				</Link>
			)}
			{snoozedCount > 0 && (
				<Link
					href={`/w/${workspacePublicId}/dashboard/mail/${identity.publicId}/snoozed`}
					className={linkCls(currentSlug === "snoozed")}
				>
					<Clock4 size={16} className="shrink-0 text-k-ink-3" />
					<span className="flex-1 truncate">Snoozed</span>
					<span className="text-[12px] tabular-nums text-k-ink-3">{snoozedCount}</span>
				</Link>
			)}
		</>
	);
}

// Folders of the active address in the sidebar.
export default function KSidebarNav({
	identityMailboxes,
	unreadCounts,
	scheduledDraftsPromise,
	snoozedThreadsPromise,
	workspacePublicId,
	onComplete,
}: {
	identityMailboxes: FetchIdentityMailboxListResult;
	unreadCounts: FetchMailboxUnreadCountsResult;
	scheduledDraftsPromise: Promise<DraftMessageEntity[]>;
	snoozedThreadsPromise: Promise<{ threads: MailboxThreadEntity[] }>;
	workspacePublicId: string | undefined;
	onComplete?: () => void;
}) {
	const pathname = usePathname();
	const params = useParams() as {
		identityPublicId?: string;
		mailboxSlug?: string;
	};

	// Current folder: the segment following the identity in the URL (not the
	// last segment, which is the thread id when a thread is open).
	const currentSlug = React.useMemo(() => {
		if (params.mailboxSlug) return params.mailboxSlug;
		const parts = pathname.split("/").filter(Boolean);
		const i = params.identityPublicId ? parts.indexOf(params.identityPublicId) : -1;
		return (i >= 0 ? parts[i + 1] : parts.at(-1)) ?? "inbox";
	}, [pathname, params.mailboxSlug, params.identityPublicId]);

	// Only the active identity's folders are shown; switching identity is done
	// in the account selector at the top of the sidebar.
	const active =
		identityMailboxes.find((im) => im.identity.publicId === params.identityPublicId) ??
		identityMailboxes[0];

	// Counters: passed to the store (to anchor the adjustments), and adjustments read.
	const countAdj = useMailStore((st) => st.countAdj);
	useEffect(() => {
		const m = new Map<string, number>();
		for (const [id, c] of unreadCounts as any) m.set(String(id), Number((c as any)?.unreadThreads ?? 0));
		syncServerCounts(m);
	}, [unreadCounts]);

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
		const isActive = params.identityPublicId === identityPublicId && currentSlug === slug;
		const [open, setOpen] = React.useState(true);
		const hasChildren = m.children.length > 0;
		// server counter + immediate adjustment from pending actions (mail-store)
		const unread = Math.max(0, m.unread + (countAdj.get(m.id)?.delta ?? 0));
		// no counter on Trash, Sent or Archive (it adds nothing)
		const showCount = unread > 0 && m.kind !== "trash" && m.kind !== "sent" && m.kind !== "archive";

		return (
			<div>
				<div className="group/item relative flex items-center">
					<Link
						href={href}
						onClick={onComplete ? () => onComplete() : undefined}
						aria-disabled={!m.selectable}
						aria-current={isActive ? "page" : undefined}
						className={cn(
							"flex min-w-0 flex-1 items-center gap-2.5 rounded-k-sm py-[7px] pr-2.5 text-[13.5px] transition-colors",
							isActive
								? "bg-k-surface font-medium text-k-ink shadow-k-pane"
								: "text-k-ink-2 hover:bg-k-hover hover:text-k-ink",
							!m.selectable && "pointer-events-none cursor-default opacity-50",
						)}
						style={{ paddingLeft: 10 + level * 14 }}
					>
						<Icon className={cn("h-4 w-4 shrink-0", isActive ? "text-k-accent" : "text-k-ink-3")} />
						<span className="flex-1 truncate">
							{m.kind === "custom" ? (m.name ?? "Folder") : TITLE[m.kind]}
						</span>
						{showCount && (
							<span
								className={cn(
									"min-w-5 rounded-full px-1.5 text-center text-[11.5px] font-semibold tabular-nums leading-5",
									m.kind === "inbox" ? "bg-k-accent text-k-accent-ink" : "text-k-ink-3",
								)}
							>
								{unread}
							</span>
						)}
					</Link>

					{hasChildren && (
						<button
							type="button"
							onClick={() => setOpen((v) => !v)}
							className="absolute -left-1 rounded p-0.5 text-k-ink-3 hover:text-k-ink"
							aria-label={open ? "Collapse" : "Expand"}
						>
							{open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
						</button>
					)}

					{m.kind === "custom" && (
						<Menu withinPortal position="right-start" offset={4}>
							<Menu.Target>
								<button
									type="button"
									onClick={(e) => e.stopPropagation()}
									className="absolute right-1 rounded p-1 text-k-ink-3 opacity-0 transition hover:bg-k-hover hover:text-k-ink group-hover/item:opacity-100"
									aria-label={`Actions for ${m.name ?? "the folder"}`}
								>
									<MoreVertical className="h-3.5 w-3.5" />
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

				{open && hasChildren && (
					<div className="mt-px space-y-px">
						{m.children.map((child) => (
							<Item key={child.id} m={child} identityPublicId={identityPublicId} identity={identity} level={level + 1} />
						))}
					</div>
				)}
			</div>
		);
	};

	if (!active) return null;
	const { identity, mailboxes } = active;
	const tree = buildTree(mailboxes as MailboxEntity[], unreadCounts);
	const system = tree.filter((m) => m.kind !== "custom");
	const custom = tree.filter((m) => m.kind === "custom");

	return (
		<nav aria-label="Folders" className="space-y-5">
			<div className="space-y-px">
				{system.map((m) => (
					<Item key={m.id} m={m} identityPublicId={identity.publicId} identity={identity} />
				))}
				<Suspense fallback={null}>
					<IdentityExtraCounts
						identity={identity}
						scheduledDraftsPromise={scheduledDraftsPromise}
						snoozedThreadsPromise={snoozedThreadsPromise}
						workspacePublicId={workspacePublicId}
						currentSlug={currentSlug}
					/>
				</Suspense>
			</div>

			<div>
				<div className="mb-1 flex items-center justify-between px-2.5">
					<span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3">Folders</span>
					<AddNewFolder mailboxes={mailboxes} identity={identity} />
				</div>
				<div className="space-y-px">
					{custom.length === 0 ? (
						<p className="px-2.5 py-1 text-[12.5px] text-k-ink-3">No folders</p>
					) : (
						custom.map((m) => (
							<Item key={m.id} m={m} identityPublicId={identity.publicId} identity={identity} />
						))
					)}
				</div>
			</div>
		</nav>
	);
}
