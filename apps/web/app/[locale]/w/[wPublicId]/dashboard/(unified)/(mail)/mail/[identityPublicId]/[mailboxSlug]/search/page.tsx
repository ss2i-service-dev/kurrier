import React from "react";
import {
	fetchIdentityMailboxList,
	fetchMailbox,
	FetchMailboxThreadsByIdsResult,
	fetchMailboxThreadsList,
	initSearch,
} from "@/lib/actions/mailbox";
import {fetchLabelsByIdentityPublicId, fetchMailboxThreadLabels} from "@/lib/actions/labels";
import { getPublicEnv, ThreadHit } from "@schema";
import SearchPagination from "@/components/mailbox/default/search-pagination";
import { PAGE_SIZE } from "@common/mail-client";
import WebmailListLabelSearch from "@/components/mailbox/default/webmail-list-label-search";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import { isModernUi } from "@/lib/actions/interface-pref";
import { KEmptyState, KPager } from "@/components/k/section";
import { Paperclip, Search, Star } from "lucide-react";
import { redirect } from "next/navigation";

async function ClassicSearchPage({
											 params,
											 searchParams,
										 }: {
	params: {mailboxSlug: string; identityPublicId: string };
	searchParams: Record<string, string | string[] | undefined>;
}) {
	const { identityPublicId, mailboxSlug } = await params;
	const resolvedSearchParams = await searchParams;

	const q = (resolvedSearchParams.q as string) ?? "";
	const has = (resolvedSearchParams.has as string) === "1";
	const unread = (resolvedSearchParams.unread as string) === "1";
	const starred = (resolvedSearchParams.starred as string) === "1";
	const page = Math.max(1, Number((resolvedSearchParams.page as string) ?? 1));

	const workspacePublicId = await getWorkspacePublicId()

	if (!workspacePublicId) {
		return (
			<div className="p-4 text-sm text-muted-foreground">
				Missing workspace context.
			</div>
		);
	}

	const { activeMailbox } = await fetchMailbox(identityPublicId, mailboxSlug);
	const publicConfig = await getPublicEnv();

	let items: ThreadHit[] = [];
	let totalThreads = 0;
	let totalMessages = 0;

	if (q.trim()) {
		const res = await initSearch(
			q,
			workspacePublicId,
			identityPublicId,
			mailboxSlug,
			has,
			unread,
			starred,
			page,
		);

		items = res.items ?? [];
		totalThreads = res.totalThreads ?? items.length;
		totalMessages = res.totalMessages ?? items.length;
	}

	const total = totalThreads || items.length;
	const totalPages = Math.max(1, Math.ceil((total || 1) / PAGE_SIZE));

	const threadIds = items.map((i) => i.threadId);

	const { threads } =
		threadIds.length > 0
			? await fetchMailboxThreadsList(activeMailbox.id, threadIds)
			: { threads: [] };

	const identityMailboxes = await fetchIdentityMailboxList();
	const globalLabels = await fetchLabelsByIdentityPublicId({
		identityPublicId,
		scope: "thread",
	});

	const labelsByThreadId =
		threads.length > 0 ? await fetchMailboxThreadLabels(threads) : {};

	return (
		<div className="p-4 space-y-4">
			<header className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">Search</h1>
				<div className="text-sm text-muted-foreground">
					{q.trim()
						? `Threads: ${totalThreads} • Messages: ${totalMessages}`
						: "Type a query to search"}
				</div>
			</header>

			<div className="text-sm text-muted-foreground">
				<span className="font-medium">Query:</span> “{q || "—"}” ·{" "}
				<span className="font-medium">Has attachment:</span>{" "}
				{has ? "Yes" : "No"} ·{" "}
				<span className="font-medium">Unread only:</span>{" "}
				{unread ? "Yes" : "No"} ·{" "}
				<span className="font-medium">Starred only:</span>{" "}
				{starred ? "Yes" : "No"}
			</div>

			{!q.trim() ? (
				<div className="text-sm text-muted-foreground">
					Use the global search box above to run a query.
				</div>
			) : items.length === 0 ? (
				<div className="text-sm text-muted-foreground">
					No results found.
				</div>
			) : (
				<WebmailListLabelSearch
					mailboxThreads={
						threads as FetchMailboxThreadsByIdsResult["threads"]
					}
					workspacePublicId={workspacePublicId}
					publicConfig={publicConfig}
					activeMailbox={activeMailbox}
					identityPublicId={identityPublicId}
					identityMailboxes={identityMailboxes}
					globalLabels={globalLabels}
					labelsByThreadId={labelsByThreadId}
					// "Select all N conversations in this search", following pages included.
					selectAllScope={{
						kind: "search",
						mailboxId: String(activeMailbox.id),
						q,
						workspacePublicId,
						identityPublicId,
						mailboxSlug,
						has,
						unread,
						starred,
					}}
					totalThreads={totalThreads}
				/>
			)}

			{q.trim() && totalPages > 1 && (
				<SearchPagination
					key={page}
					total={total}
					workspacePublicId={workspacePublicId}
					pageSize={PAGE_SIZE}
					page={page}
					identityPublicId={identityPublicId}
					mailboxSlug={mailboxSlug}
					q={q}
					has={has}
					unread={unread}
					starred={starred}
				/>
			)}
		</div>
	);
}

// Modern interface (per-user option): same data, different presentation (the
// list + reader frame and the search bar come from the folder layout).
async function ModernSearchPage({
	params,
	searchParams,
}: {
	params: {mailboxSlug: string; identityPublicId: string };
	searchParams: Record<string, string | string[] | undefined>;
}) {
	const { identityPublicId, mailboxSlug } = await params;
	const resolvedSearchParams = await searchParams;

	const q = (resolvedSearchParams.q as string) ?? "";
	const has = (resolvedSearchParams.has as string) === "1";
	const unread = (resolvedSearchParams.unread as string) === "1";
	const starred = (resolvedSearchParams.starred as string) === "1";
	const page = Math.max(1, Number((resolvedSearchParams.page as string) ?? 1));

	const workspacePublicId = await getWorkspacePublicId();
	if (!workspacePublicId) {
		return <KEmptyState icon={<Search size={22} strokeWidth={1.6} />} title="Workspace not found" />;
	}

	const { activeMailbox } = await fetchMailbox(identityPublicId, mailboxSlug);
	const publicConfig = await getPublicEnv();

	let items: ThreadHit[] = [];
	let totalThreads = 0;
	let totalMessages = 0;
	if (q.trim()) {
		const res = await initSearch(q, workspacePublicId, identityPublicId, mailboxSlug, has, unread, starred, page);
		items = res.items ?? [];
		totalThreads = res.totalThreads ?? items.length;
		totalMessages = res.totalMessages ?? items.length;
	}
	const total = totalThreads || items.length;

	const threadIds = items.map((i) => i.threadId);
	const { threads } = threadIds.length > 0 ? await fetchMailboxThreadsList(activeMailbox.id, threadIds) : { threads: [] };
	const identityMailboxes = await fetchIdentityMailboxList();
	const globalLabels = await fetchLabelsByIdentityPublicId({ identityPublicId, scope: "thread" });
	const labelsByThreadId = threads.length > 0 ? await fetchMailboxThreadLabels(threads) : {};

	const chips = [
		has && { icon: <Paperclip size={12} />, label: "With attachment" },
		unread && { icon: null, label: "Unread" },
		starred && { icon: <Star size={12} />, label: "Starred" },
	].filter(Boolean) as { icon: React.ReactNode; label: string }[];

	const pagerHref = (n: number) => {
		const sp = new URLSearchParams();
		if (q) sp.set("q", q);
		sp.set("has", has ? "1" : "0");
		sp.set("unread", unread ? "1" : "0");
		sp.set("starred", starred ? "1" : "0");
		sp.set("page", String(n));
		return `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${mailboxSlug}/search?${sp.toString()}`;
	};

	if (!q.trim()) {
		return (
			<KEmptyState
				icon={<Search size={22} strokeWidth={1.6} />}
				title="Search"
				text="Type some words in the search bar above to find messages."
			/>
		);
	}

	return (
		<div className="k-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="flex flex-wrap items-center gap-1.5 px-4 pb-1 pt-1 text-[12.5px] text-k-ink-3">
				<span>
					{totalThreads} thread{totalThreads > 1 ? "s" : ""} · {totalMessages} message{totalMessages > 1 ? "s" : ""}
				</span>
				{chips.map((c) => (
					<span key={c.label} className="inline-flex items-center gap-1 rounded-full bg-k-accent-soft px-2 py-0.5 font-medium text-k-accent-soft-ink">
						{c.icon}
						{c.label}
					</span>
				))}
			</div>
			<WebmailListLabelSearch
				mailboxThreads={threads as FetchMailboxThreadsByIdsResult["threads"]}
				workspacePublicId={workspacePublicId}
				publicConfig={publicConfig}
				activeMailbox={activeMailbox}
				identityPublicId={identityPublicId}
				identityMailboxes={identityMailboxes}
				globalLabels={globalLabels}
				labelsByThreadId={labelsByThreadId}
				selectAllScope={{
					kind: "search",
					mailboxId: String(activeMailbox.id),
					q,
					workspacePublicId,
					identityPublicId,
					mailboxSlug,
					has,
					unread,
					starred,
				}}
				totalThreads={totalThreads}
				kTitle={`Results for "${q}"`}
				kEmptyTitle="No results"
				kEmptyText={`No message matches "${q}". Try other words or remove a filter.`}
			/>
			<KPager page={page} total={total} pageSize={PAGE_SIZE} href={pagerHref} />
		</div>
	);
}

export default async function SearchPage(props: {
	params: {mailboxSlug: string; identityPublicId: string; wPublicId?: string };
	searchParams: Record<string, string | string[] | undefined>;
}) {
	// URL without a real folder (.../undefined/search coming from a page without a
	// folder): redirect to the inbox search instead of a "Mailbox not found" server
	// error (a tab would stay on the broken URL and reloading would request it again).
	const { mailboxSlug, identityPublicId, wPublicId } = await props.params;
	if (!mailboxSlug || mailboxSlug === "undefined") {
		const sp = new URLSearchParams();
		for (const [key, v] of Object.entries(await props.searchParams)) {
			if (typeof v === "string") sp.set(key, v);
		}
		const qs = sp.toString();
		redirect(`/w/${wPublicId}/dashboard/mail/${identityPublicId}/inbox/search${qs ? `?${qs}` : ""}`);
	}
	return (await isModernUi()) ? <ModernSearchPage {...props} /> : <ClassicSearchPage {...props} />;
}
