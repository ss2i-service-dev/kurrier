"use client";
// SS2i (nouvelle interface) : liste des fils d'un dossier. Memes donnees et
// memes comportements que webmail-list.tsx (fils masques des le clic via
// pending-moves, Outbox des envois en attente dans Drafts, actualisation tant
// qu'un envoi est en cours), presentation de la nouvelle interface, filtre
// Tous / Non lus (servi par le serveur, page par page), fils epingles en tete.
import * as React from "react";
import { use } from "react";
import { usePathname } from "next/navigation";
import { Inbox } from "lucide-react";
import { IconMail, IconPinnedFilled, IconSend } from "@tabler/icons-react";
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
import { settle, settlePins, useMailStore } from "@/components/k/mail-store";
import { fetchKThreadPage, fetchKUnreadPage } from "@/lib/actions/k-threads";
import type { fetchKPinnedThreads } from "@/lib/actions/k-pins";

const PAGE_SIZE = 50;

type Thread = FetchMailboxThreadsResult[number];
type PinnedData = Awaited<ReturnType<typeof fetchKPinnedThreads>>;

type Props = {
	mailboxThreadPromise: Promise<{
		mailboxThreads: FetchMailboxThreadsResult;
		labelsByThreadId: FetchMailboxThreadLabelsResult;
		/** Fils avec une vraie piece jointe (hors images de signature). */
		realAttachments?: string[];
	}>;
	pinnedPromise?: Promise<PinnedData>;
	publicConfig: PublicConfig;
	identityPublicId: string;
	identityMailboxesPromise: Promise<FetchIdentityMailboxListResult>;
	fetchMailboxPromise: Promise<FetchMailboxResult>;
	globalLabelsPromise: Promise<FetchLabelsResult>;
	workspacePublicId?: string;
	/** Page de depart (?page=), les suivantes se chargent au defilement. */
	startPage?: number;
};

const NO_PINS: Promise<PinnedData> = Promise.resolve({ pinnedIds: [], mailboxThreads: [], labelsByThreadId: {}, realAttachments: [] });
const keyOf = (t: Thread) => `${t.threadId}:${t.mailboxId}`;
// Ordre de la liste serveur : activite effective (sortie de report comprise).
const activityOf = (t: Thread) => new Date((t as any).unsnoozedAt ?? t.lastActivityAt).getTime();

export default function KThreadList(props: Props) {
	const { activeMailbox } = use(props.fetchMailboxPromise);
	return (
		<DynamicContextProvider
			initialState={{ selectedThreadIds: new Set(), activeMailbox, identityPublicId: props.identityPublicId, filter: "all" }}
		>
			<ListBody {...props} />
		</DynamicContextProvider>
	);
}

function ListBody({
	mailboxThreadPromise,
	pinnedPromise = NO_PINS,
	identityPublicId,
	publicConfig,
	identityMailboxesPromise,
	globalLabelsPromise,
	workspacePublicId,
	fetchMailboxPromise,
	startPage = 1,
}: Props) {
	const { labelsByThreadId: serverLabels, mailboxThreads: serverFirst, realAttachments: serverFiles } = use(mailboxThreadPromise);
	const pinnedData = use(pinnedPromise);
	const globalLabels = use(globalLabelsPromise);
	const { mailboxSync, activeMailbox, count } = use(fetchMailboxPromise);
	const identityMailboxes = use(identityMailboxesPromise);
	const isHidden = useHiddenThreads();
	const { state } = useDynamicContext<{ filter?: "all" | "unread" }>();
	const unreadMode = state?.filter === "unread";
	const active = useMailStore((s) => s.active);
	const mailboxSlug = String(activeMailbox.slug);

	// Chargement au defilement : la premiere page vient du serveur (et se met a
	// jour a chaque actualisation), les suivantes sont demandees quand la fin de
	// la liste approche, puis fusionnees sans doublon.
	const more = useMoreThreads({ identityPublicId, mailboxSlug, startPage, firstPageLength: serverFirst.length, serverFirst });
	// « Non lus » : liste a part, demandee au serveur (seulement les non-lus).
	const unread = useUnreadPages({ identityPublicId, mailboxSlug, enabled: unreadMode, refreshSignal: serverFirst, keepId: active });

	const allThreads = React.useMemo(() => {
		if (more.threads.length === 0) return serverFirst;
		const seen = new Set(serverFirst.map(keyOf));
		const out = serverFirst.slice();
		for (const t of more.threads) {
			if (!seen.has(keyOf(t))) {
				seen.add(keyOf(t));
				out.push(t);
			}
		}
		return out;
	}, [serverFirst, more.threads]);

	// Trombone : seulement pour une vraie piece jointe (pas une image de signature).
	const realFiles = React.useMemo(
		() =>
			new Set<string>([
				...(serverFiles ?? []),
				...more.files,
				...unread.files,
				...((pinnedData as any).realAttachments ?? []),
			]),
		[serverFiles, more.files, unread.files, pinnedData],
	);
	const withFiles = React.useCallback(
		(list: FetchMailboxThreadsResult) =>
			list.map((t) => (t.hasAttachments && !realFiles.has(String(t.threadId)) ? { ...t, hasAttachments: false } : t)),
		[realFiles],
	);
	const baseThreads = withFiles(unreadMode ? unread.threads : allThreads);
	const labelsByThreadId = React.useMemo(
		() => ({ ...pinnedData.labelsByThreadId, ...more.labels, ...unread.labels, ...serverLabels }),
		[pinnedData.labelsByThreadId, more.labels, unread.labels, serverLabels],
	);
	const loadedTotal = (startPage - 1) * PAGE_SIZE + allThreads.length;
	const hasMore = unreadMode ? unread.hasMore : more.hasMore && loadedTotal < count;
	const pager = unreadMode ? unread : more;

	// Epingles : fils du dossier epingles par l'utilisateur, en tete de liste.
	const pinOverride = useMailStore((s) => s.pinned);
	const serverPinned = React.useMemo(() => new Set(pinnedData.pinnedIds.map(String)), [pinnedData.pinnedIds]);
	React.useEffect(() => settlePins(serverPinned), [serverPinned]);
	const isPinned = (id: string) => pinOverride.get(String(id)) ?? serverPinned.has(String(id));

	const visible = baseThreads.filter((t) => !isHidden(String(t.mailboxId), String(t.threadId)));
	const visibleKeys = new Set(visible.map(keyOf));
	const fromPins = withFiles(pinnedData.mailboxThreads as Thread[]).filter(
		(t) => !visibleKeys.has(keyOf(t)) && !isHidden(String(t.mailboxId), String(t.threadId)),
	);
	const pinnedRows = [...fromPins, ...visible]
		.filter((t) => isPinned(String(t.threadId)))
		.sort((a, b) => activityOf(b) - activityOf(a));
	let regular = visible.filter((t) => !isPinned(String(t.threadId)));
	// Un fil desepingle hors des pages chargees reprend sa place s'il en a une
	// parmi elles (sinon il viendra avec les pages suivantes).
	const unpinned = fromPins.filter((t) => !isPinned(String(t.threadId)));
	if (unpinned.length) {
		const last = regular[regular.length - 1];
		const fits = unpinned.filter((t) => !hasMore || !last || activityOf(t) >= activityOf(last));
		if (fits.length) regular = [...regular, ...fits].sort((a, b) => activityOf(b) - activityOf(a));
	}
	const shown = [...pinnedRows, ...regular];

	const ownAddresses = React.useMemo(
		() => new Set(identityMailboxes.map((im) => String(im.identity.value).toLowerCase())),
		[identityMailboxes],
	);

	// Nouvelles donnees serveur : on abandonne les surcharges optimistes confirmees.
	React.useEffect(() => {
		settle(
			[...allThreads, ...(pinnedData.mailboxThreads as Thread[])].map((t) => ({
				threadId: String(t.threadId),
				unreadCount: t.unreadCount,
				starred: t.starred,
			})),
		);
	}, [allThreads, pinnedData.mailboxThreads]);

	// Tant qu'un brouillon de la liste est en cours d'envoi, la liste est actualisee.
	useSendRefresh(anySendTracked(shown.map((t) => t.draftSend)));

	return (
		<>
			<KListHeader
				mailboxThreads={shown}
				mailboxSync={mailboxSync ?? undefined}
				publicConfig={publicConfig}
				identityMailboxes={identityMailboxes}
				activeMailbox={activeMailbox}
				selectAllScope={{ kind: "mailbox", mailboxId: String(activeMailbox.id) }}
				mayHaveMore={count > shown.length}
			/>
			<Rows
				pinned={pinnedRows}
				threads={regular}
				loading={unreadMode && unread.loading && unread.threads.length === 0}
				activeMailbox={activeMailbox}
				identityPublicId={identityPublicId}
				mailboxSync={mailboxSync ?? undefined}
				labelsByThreadId={labelsByThreadId}
				globalLabels={globalLabels}
				workspacePublicId={workspacePublicId}
				ownAddresses={ownAddresses}
			/>
			{hasMore && !(unreadMode && unread.threads.length === 0) && (
				<LoadMoreSentinel key={unreadMode ? "u" : "a"} onVisible={pager.loadNext} loading={pager.loading} error={pager.error} />
			)}
		</>
	);
}

function Rows({
	pinned,
	threads,
	loading,
	activeMailbox,
	identityPublicId,
	mailboxSync,
	labelsByThreadId,
	globalLabels,
	workspacePublicId,
	ownAddresses,
}: {
	pinned: FetchMailboxThreadsResult;
	threads: FetchMailboxThreadsResult;
	loading: boolean;
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
	const active = useMailStore((s) => s.active);
	const isOnSnoozedPage = (usePathname() ?? "").split("/").includes("snoozed");

	// « Non lus » : un fil lu a l'instant reste affiche tant qu'il est ouvert.
	const keepUnread = (list: FetchMailboxThreadsResult) =>
		filter === "unread"
			? list.filter((t) => {
					if (String(t.threadId) === active) return true;
					const o = readOverride.get(String(t.threadId));
					return o === undefined ? t.unreadCount > 0 : !o;
				})
			: list;
	const pinnedRows = keepUnread(pinned);
	const rows = keepUnread(threads);
	const orderedThreadIds = [...pinnedRows, ...rows].map((t) => String(t.threadId));

	if (loading) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 py-16 text-[13px] text-k-ink-3">
				<span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-k-line-strong border-t-k-accent" />
				Chargement des non lus…
			</div>
		);
	}

	if (rows.length === 0 && pinnedRows.length === 0) {
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

	const row = (isPinnedRow: boolean) => (item: Thread) => (
		<KThreadRow
			key={item.threadId + item.mailboxId}
			item={item}
			pinned={isPinnedRow}
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
			{pinnedRows.length > 0 && (
				<>
					<li className={`${section} flex items-center gap-1.5`}>
						<IconPinnedFilled size={12} aria-hidden />
						Épinglés ({pinnedRows.length})
					</li>
					{pinnedRows.map(row(true))}
					{/* Fin des epingles : bande vide de la couleur du fond de page, d'un
					    bord a l'autre du panneau. Epingles et reste de la liste se lisent
					    comme deux cartes empilees. */}
					{rows.length > 0 && sending.length === 0 && (
						<>
							<li aria-hidden className="!my-1.5 -mx-1.5 h-3 border-y border-k-line bg-k-canvas" />
							<li className={`${section} flex items-center gap-1.5`}>
								<IconMail size={12} aria-hidden />
								Messages
							</li>
						</>
					)}
				</>
			)}
			{sending.length > 0 ? (
				<>
					<li className={`${section} flex items-center gap-1.5 !text-k-accent`}>
						<IconSend size={13} aria-hidden />
						Envois en attente ({sending.length}) · annulables
					</li>
					{sending.map(row(false))}
					<li className={section}>Brouillons ({drafts.length})</li>
					{drafts.map(row(false))}
				</>
			) : (
				rows.map(row(false))
			)}
		</ul>
	);
}

/** Fils non lus du dossier, page par page (filtre « Non lus »). */
function useUnreadPages({
	identityPublicId,
	mailboxSlug,
	enabled,
	refreshSignal,
	keepId,
}: {
	identityPublicId: string;
	mailboxSlug: string;
	enabled: boolean;
	refreshSignal: unknown;
	keepId: string | null;
}) {
	const [pages, setPages] = React.useState<ThreadPage[]>([]);
	const [loading, setLoading] = React.useState(false);
	const [error, setError] = React.useState(false);
	const [ended, setEnded] = React.useState(false);
	const busy = React.useRef(false);
	const gen = React.useRef(0);
	const pagesRef = React.useRef(pages);
	pagesRef.current = pages;
	const keepRef = React.useRef(keepId);
	keepRef.current = keepId;

	const fetchPage = React.useCallback(
		(page: number, replace: boolean) => {
			busy.current = true;
			setLoading(true);
			setError(false);
			const g = gen.current;
			fetchKUnreadPage(identityPublicId, mailboxSlug, page)
				.then((res) => {
					if (g !== gen.current) return;
					setPages((p) => (replace ? [res] : [...p, res]));
					setEnded(res.mailboxThreads.length < PAGE_SIZE);
				})
				.catch(() => {
					if (g === gen.current) setError(true);
				})
				.finally(() => {
					if (g !== gen.current) return;
					busy.current = false;
					setLoading(false);
				});
		},
		[identityPublicId, mailboxSlug],
	);

	// Activation du filtre, autre dossier : premiere page.
	React.useEffect(() => {
		gen.current++;
		busy.current = false;
		setPages([]);
		setEnded(false);
		setError(false);
		setLoading(false);
		if (enabled) fetchPage(1, true);
	}, [enabled, fetchPage]);

	// Actualisation serveur : les pages chargees sont redemandees ; le fil ouvert
	// (lu a l'instant) reste a sa place pour ne pas disparaitre sous le curseur.
	const firstRun = React.useRef(true);
	React.useEffect(() => {
		if (firstRun.current) {
			firstRun.current = false;
			return;
		}
		const n = pagesRef.current.length;
		if (!enabled || n === 0 || busy.current) return;
		const g = gen.current;
		const old = pagesRef.current.flatMap((p) => p.mailboxThreads);
		Promise.all(Array.from({ length: n }, (_, i) => fetchKUnreadPage(identityPublicId, mailboxSlug, i + 1)))
			.then((fresh) => {
				if (g !== gen.current) return;
				const keep = keepRef.current;
				const kept = keep ? old.find((t) => String(t.threadId) === keep) : undefined;
				if (kept && !fresh.some((p) => p.mailboxThreads.some((t) => String(t.threadId) === keep))) {
					const all = [...fresh.flatMap((p) => p.mailboxThreads), kept].sort((a, b) => activityOf(b) - activityOf(a));
					fresh = [
						{
							mailboxThreads: all,
							labelsByThreadId: Object.assign({}, ...fresh.map((p) => p.labelsByThreadId)),
							realAttachments: [...fresh.flatMap((p) => p.realAttachments), ...(kept.hasAttachments ? [String(kept.threadId)] : [])],
						},
					];
				}
				setPages(fresh);
			})
			.catch(() => {});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refreshSignal]);

	const loadNext = React.useCallback(() => {
		if (busy.current || ended || !enabled) return;
		// Numero de page d'apres le nombre de fils deja recus (les pages fusionnees comptent pour plusieurs).
		const received = pagesRef.current.reduce((n, p) => n + p.mailboxThreads.length, 0);
		fetchPage(Math.floor(received / PAGE_SIZE) + 1, false);
	}, [ended, enabled, fetchPage]);

	const threads = React.useMemo(() => {
		const seen = new Set<string>();
		const out: Thread[] = [];
		for (const t of pages.flatMap((p) => p.mailboxThreads)) {
			if (seen.has(keyOf(t))) continue;
			seen.add(keyOf(t));
			out.push(t);
		}
		return out;
	}, [pages]);
	const labels = React.useMemo(
		() => Object.assign({}, ...pages.map((p) => p.labelsByThreadId)) as FetchMailboxThreadLabelsResult,
		[pages],
	);
	const files = React.useMemo(() => pages.flatMap((p) => (p as any).realAttachments ?? []) as string[], [pages]);
	return { threads, labels, files, loadNext, loading, error, hasMore: enabled && !ended };
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
	const files = React.useMemo(() => pages.flatMap((p) => (p as any).realAttachments ?? []) as string[], [pages]);
	return { threads, labels, files, loadNext, loading, error, hasMore: !ended && firstPageLength >= PAGE_SIZE };
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
