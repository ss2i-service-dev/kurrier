"use client";
// SS2i (nouvelle interface) : liste des fils d'un dossier. Memes donnees et
// memes comportements que webmail-list.tsx (fils masques des le clic via
// pending-moves, Outbox des envois en attente dans Drafts, actualisation tant
// qu'un envoi est en cours), presentation de la nouvelle interface, filtre
// Tous / Non lus.
import * as React from "react";
import { use } from "react";
import { usePathname } from "next/navigation";
import { Inbox } from "lucide-react";
import { IconSend } from "@tabler/icons-react";
import { PublicConfig } from "@schema";
import {
	FetchIdentityMailboxListResult,
	FetchMailboxResult,
	FetchMailboxThreadsResult,
} from "@/lib/actions/mailbox";
import { FetchLabelsResult, FetchMailboxThreadLabelsResult } from "@/lib/actions/labels";
import { DynamicContextProvider, useDynamicContext } from "@/hooks/use-dynamic-context";
import { useHiddenThreads } from "@/lib/pending-moves";
import { anySendTracked, isSendingDraft, useSendRefresh } from "@/components/mailbox/default/draft-send-status";
import KListHeader from "@/components/k/list-header";
import KThreadRow from "@/components/k/thread-row";
import { mailboxTitle } from "@/components/k/format";
import { settle, useMailStore } from "@/components/k/mail-store";
import { fetchKThreadPage } from "@/lib/actions/k-threads";

const PAGE_SIZE = 50;

type Props = {
	mailboxThreadPromise: Promise<{ mailboxThreads: FetchMailboxThreadsResult; labelsByThreadId: FetchMailboxThreadLabelsResult }>;
	publicConfig: PublicConfig;
	identityPublicId: string;
	identityMailboxesPromise: Promise<FetchIdentityMailboxListResult>;
	fetchMailboxPromise: Promise<FetchMailboxResult>;
	globalLabelsPromise: Promise<FetchLabelsResult>;
	workspacePublicId?: string;
	/** Page de depart (?page=), les suivantes se chargent au defilement. */
	startPage?: number;
};

export default function KThreadList({
	mailboxThreadPromise,
	identityPublicId,
	publicConfig,
	identityMailboxesPromise,
	globalLabelsPromise,
	workspacePublicId,
	fetchMailboxPromise,
	startPage = 1,
}: Props) {
	const { labelsByThreadId: serverLabels, mailboxThreads: serverFirst } = use(mailboxThreadPromise);
	const globalLabels = use(globalLabelsPromise);
	const { mailboxSync, activeMailbox, count } = use(fetchMailboxPromise);
	const identityMailboxes = use(identityMailboxesPromise);
	const isHidden = useHiddenThreads();

	// Chargement au defilement : la premiere page vient du serveur (et se met a
	// jour a chaque actualisation), les suivantes sont demandees quand la fin de
	// la liste approche, puis fusionnees sans doublon.
	const more = useMoreThreads({
		identityPublicId,
		mailboxSlug: String(activeMailbox.slug),
		startPage,
		firstPageLength: serverFirst.length,
		serverFirst,
	});
	const serverThreads = React.useMemo(() => {
		if (more.threads.length === 0) return serverFirst;
		const seen = new Set(serverFirst.map((t) => `${t.threadId}:${t.mailboxId}`));
		const out = serverFirst.slice();
		for (const t of more.threads) {
			const k = `${t.threadId}:${t.mailboxId}`;
			if (!seen.has(k)) {
				seen.add(k);
				out.push(t);
			}
		}
		return out;
	}, [serverFirst, more.threads]);
	const labelsByThreadId = React.useMemo(
		() => (more.threads.length ? { ...more.labels, ...serverLabels } : serverLabels),
		[serverLabels, more.labels, more.threads.length],
	);
	const mailboxThreads = serverThreads.filter((t) => !isHidden(String(t.mailboxId), String(t.threadId)));
	const loadedTotal = (startPage - 1) * PAGE_SIZE + serverThreads.length;
	const hasMore = more.hasMore && loadedTotal < count;
	const ownAddresses = React.useMemo(
		() => new Set(identityMailboxes.map((im) => String(im.identity.value).toLowerCase())),
		[identityMailboxes],
	);

	// Nouvelles donnees serveur : on abandonne les surcharges optimistes confirmees.
	React.useEffect(() => {
		settle(serverThreads.map((t) => ({ threadId: String(t.threadId), unreadCount: t.unreadCount, starred: t.starred })));
	}, [serverThreads]);

	// Tant qu'un brouillon de la liste est en cours d'envoi, la liste est actualisee.
	useSendRefresh(anySendTracked(mailboxThreads.map((t) => t.draftSend)));

	return (
		<DynamicContextProvider initialState={{ selectedThreadIds: new Set(), activeMailbox, identityPublicId, filter: "all" }}>
			<KListHeader
				mailboxThreads={mailboxThreads}
				mailboxSync={mailboxSync ?? undefined}
				publicConfig={publicConfig}
				identityMailboxes={identityMailboxes}
				activeMailbox={activeMailbox}
				selectAllScope={{ kind: "mailbox", mailboxId: String(activeMailbox.id) }}
				mayHaveMore={count > mailboxThreads.length}
			/>
			<Rows
				threads={mailboxThreads}
				activeMailbox={activeMailbox}
				identityPublicId={identityPublicId}
				mailboxSync={mailboxSync ?? undefined}
				labelsByThreadId={labelsByThreadId}
				globalLabels={globalLabels}
				workspacePublicId={workspacePublicId}
				ownAddresses={ownAddresses}
			/>
			{hasMore && <LoadMoreSentinel onVisible={more.loadNext} loading={more.loading} error={more.error} />}
		</DynamicContextProvider>
	);
}

function Rows({
	threads,
	activeMailbox,
	identityPublicId,
	mailboxSync,
	labelsByThreadId,
	globalLabels,
	workspacePublicId,
	ownAddresses,
}: {
	threads: FetchMailboxThreadsResult;
	activeMailbox: FetchMailboxResult["activeMailbox"];
	identityPublicId: string;
	mailboxSync: FetchMailboxResult["mailboxSync"] | undefined;
	labelsByThreadId: FetchMailboxThreadLabelsResult;
	globalLabels: FetchLabelsResult;
	workspacePublicId?: string;
	ownAddresses: Set<string>;
}) {
	const { state } = useDynamicContext<{ filter?: "all" | "unread" }>();
	const filter = state?.filter ?? "all";
	const readOverride = useMailStore((s) => s.read);
	const isOnSnoozedPage = (usePathname() ?? "").split("/").includes("snoozed");

	const rows =
		filter === "unread"
			? threads.filter((t) => {
					const o = readOverride.get(String(t.threadId));
					return o === undefined ? t.unreadCount > 0 : !o;
				})
			: threads;
	const orderedThreadIds = rows.map((t) => String(t.threadId));

	if (rows.length === 0) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
				<div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-k-hover text-k-ink-3">
					<Inbox size={22} strokeWidth={1.6} />
				</div>
				<p className="text-[14px] font-medium text-k-ink">{filter === "unread" ? "Tout est lu" : "Rien ici"}</p>
				<p className="text-[13px] text-k-ink-3">
					{filter === "unread"
						? "Aucun message non lu."
						: `Aucun message dans « ${mailboxTitle(activeMailbox.kind, activeMailbox.name)} ».`}
				</p>
			</div>
		);
	}

	const row = (item: FetchMailboxThreadsResult[number]) => (
		<KThreadRow
			key={item.threadId + item.mailboxId}
			item={item}
			workspacePublicId={workspacePublicId}
			orderedThreadIds={orderedThreadIds}
			activeMailbox={activeMailbox}
			identityPublicId={identityPublicId}
			mailboxSync={mailboxSync}
			globalLabels={globalLabels}
			labelsByThreadId={labelsByThreadId}
			ownAddresses={ownAddresses}
			isOnSnoozedPage={isOnSnoozedPage}
		/>
	);

	// Dans Drafts, les envois en attente (Undo encore possible) forment une Outbox
	// en tete, a part des brouillons.
	const isDraftsBox = activeMailbox.kind === "drafts";
	const sending = isDraftsBox ? rows.filter((t) => isSendingDraft(t.draftSend)) : [];
	const drafts = isDraftsBox ? rows.filter((t) => !isSendingDraft(t.draftSend)) : rows;
	const section = "px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3";

	return (
		<ul role="list" className="space-y-px px-1.5 pb-2">
			{sending.length > 0 ? (
				<>
					<li className={`${section} flex items-center gap-1.5 !text-k-accent`}>
						<IconSend size={13} aria-hidden />
						Envois en attente ({sending.length}) · annulables
					</li>
					{sending.map(row)}
					<li className={section}>Brouillons ({drafts.length})</li>
					{drafts.map(row)}
				</>
			) : (
				rows.map(row)
			)}
		</ul>
	);
}

type ThreadPage = Awaited<ReturnType<typeof fetchKThreadPage>>;

function useMoreThreads({
	identityPublicId,
	mailboxSlug,
	startPage,
	firstPageLength,
	serverFirst,
}: {
	identityPublicId: string;
	mailboxSlug: string;
	startPage: number;
	firstPageLength: number;
	serverFirst: FetchMailboxThreadsResult;
}) {
	const [pages, setPages] = React.useState<ThreadPage[]>([]);
	const [loading, setLoading] = React.useState(false);
	const [error, setError] = React.useState(false);
	const [ended, setEnded] = React.useState(false);
	const busy = React.useRef(false);
	const gen = React.useRef(0);
	const pagesRef = React.useRef(pages);
	pagesRef.current = pages;

	// Autre dossier ou autre page de depart : on repart de zero.
	React.useEffect(() => {
		gen.current++;
		busy.current = false;
		setPages([]);
		setEnded(false);
		setError(false);
		setLoading(false);
	}, [identityPublicId, mailboxSlug, startPage]);

	// Actualisation serveur (nouveau message, suppression...) : les pages deja
	// chargees sont redemandees en arriere-plan pour ne pas rester figees.
	const firstRun = React.useRef(true);
	React.useEffect(() => {
		if (firstRun.current) {
			firstRun.current = false;
			return;
		}
		const n = pagesRef.current.length;
		if (n === 0 || busy.current) return;
		const g = gen.current;
		Promise.all(Array.from({ length: n }, (_, i) => fetchKThreadPage(identityPublicId, mailboxSlug, startPage + 1 + i)))
			.then((fresh) => {
				if (g === gen.current) setPages(fresh);
			})
			.catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [serverFirst]);

	const loadNext = React.useCallback(() => {
		if (busy.current || ended) return;
		busy.current = true;
		setLoading(true);
		setError(false);
		const g = gen.current;
		const next = startPage + 1 + pagesRef.current.length;
		fetchKThreadPage(identityPublicId, mailboxSlug, next)
			.then((res) => {
				if (g !== gen.current) return;
				setPages((p) => [...p, res]);
				if (res.mailboxThreads.length < PAGE_SIZE) setEnded(true);
			})
			.catch(() => {
				if (g === gen.current) setError(true);
			})
			.finally(() => {
				if (g !== gen.current) return;
				busy.current = false;
				setLoading(false);
			});
	}, [identityPublicId, mailboxSlug, startPage, ended]);

	const threads = React.useMemo(() => pages.flatMap((p) => p.mailboxThreads), [pages]);
	const labels = React.useMemo(
		() => Object.assign({}, ...pages.map((p) => p.labelsByThreadId)) as FetchMailboxThreadLabelsResult,
		[pages],
	);
	return { threads, labels, loadNext, loading, error, hasMore: !ended && firstPageLength >= PAGE_SIZE };
}

function LoadMoreSentinel({ onVisible, loading, error }: { onVisible: () => void; loading: boolean; error: boolean }) {
	const ref = React.useRef<HTMLDivElement>(null);
	const cb = React.useRef(onVisible);
	cb.current = onVisible;

	React.useEffect(() => {
		const el = ref.current;
		if (!el || error) return;
		const root = el.closest(".k-scroll");
		const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), {
			root,
			rootMargin: "0px 0px 800px 0px",
		});
		io.observe(el);
		return () => io.disconnect();
		// relance apres chaque chargement : si la sentinelle est encore visible, on enchaine
	}, [loading, error]);

	return (
		<div ref={ref} className="flex h-12 shrink-0 items-center justify-center text-[12.5px] text-k-ink-3">
			{error ? (
				<button type="button" onClick={onVisible} className="rounded-k-sm px-2 py-1 text-k-accent hover:bg-k-hover">
					Échec du chargement · réessayer
				</button>
			) : loading ? (
				<span className="flex items-center gap-2">
					<span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-k-line-strong border-t-k-accent" />
					Chargement…
				</span>
			) : null}
		</div>
	);
}
