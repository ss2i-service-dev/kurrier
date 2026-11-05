"use client";
// The two working columns. The list keeps its width and scroll position when a
// thread opens on the right; on mobile only one is visible.
import React, { startTransition, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { registerRefresher, setActiveThread, setClosingThread, setComposeSlot, useMailStore } from "@/components/k/mail-store";
import { Inbox } from "lucide-react";

export const isThreadPath = (p?: string | null) => /\/threads\/[^/]+/.test(p ?? "");

// Direct load of a thread URL (link, F5, reload): Next then mounts the
// non-intercepted "thread" page in the background. As soon as another thread is
// opened (intercepted route), the background stays that of the first thread and
// the slightest refresh (after read / unread, archive...) no longer matches:
// Next reloads the whole page. So the usual state is restored right away: the
// list in the background, then the thread on top, as after a click in the list.
let directLoadHandled = false;
const DIRECT_THREAD = /^(\/(?:en|ko)\/w\/[^/]+\/dashboard\/mail\/[^/]+\/[^/]+)\/threads\/[^/]+\/?$/;

export default function MailPanes({ list, reader }: { list: React.ReactNode; reader: React.ReactNode }) {
	const pathname = usePathname();
	// Closing a thread: hidden immediately, navigation to the list follows.
	const closing = useMailStore((s) => s.closing);
	const onThread = isThreadPath(pathname) && !(closing && pathname?.includes(`/threads/${closing}`));
	const composingRaw = useMailStore((s) => s.composing);
	const parked = useMailStore((s) => s.composeParked);
	// Undoable send in progress: the pane goes back to the thread or the empty
	// screen, the editor stays mounted (hidden) so "Undo send" keeps working.
	const composing = composingRaw && !parked;
	const router = useRouter();
	// Deferred refresh after a burst of optimistic actions, in a transition
	// (non-blocking). Also ends the "opening in progress" state once the URL has
	// changed.
	useEffect(() => registerRefresher(() => startTransition(() => router.refresh())), [router]);
	useEffect(() => {
		setActiveThread(pathname?.match(/\/threads\/([^/]+)/)?.[1] ?? null);
		setClosingThread(null);
	}, [pathname]);

	const reopen = React.useRef<{ list: string; target: string } | null>(null);
	useEffect(() => {
		if (directLoadHandled) return;
		directLoadHandled = true;
		const m = DIRECT_THREAD.exec(window.location.pathname);
		if (!m) return;
		reopen.current = { list: m[1], target: window.location.pathname + window.location.search };
		router.replace(m[1], { scroll: false });
	}, [router]);
	useEffect(() => {
		const r = reopen.current;
		if (!r || pathname !== r.list) return;
		reopen.current = null;
		router.replace(r.target, { scroll: false });
	}, [pathname, router]);
	return (
		<div className="flex min-w-0 flex-1 gap-2">
			<section
				aria-label="Messages"
				className={`${onThread || composing ? "hidden lg:flex" : "flex"} w-full min-w-0 flex-col overflow-hidden bg-k-surface md:rounded-k-pane md:shadow-k-pane lg:w-[400px] lg:shrink-0 xl:w-[440px]`}
			>
				{list}
			</section>
			<section
				aria-label="Reading"
				className={`${onThread || composing ? "flex" : "hidden lg:flex"} min-w-0 flex-1 flex-col overflow-hidden bg-k-surface md:rounded-k-pane md:shadow-k-pane`}
			>
				{/* New message: the editor (compose-mail.tsx) is rendered here through a portal. */}
				{composingRaw && (
					<div ref={setComposeSlot} data-k-compose className={composing ? "flex min-h-0 flex-1 flex-col" : "hidden"} />
				)}
				{!composing && (onThread ? reader : <EmptyReader />)}
			</section>
		</div>
	);
}

function EmptyReader() {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			<div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-k-hover text-k-ink-3">
				<Inbox size={24} strokeWidth={1.6} />
			</div>
			<div>
				<p className="text-[15px] font-medium text-k-ink">No message selected</p>
				<p className="mt-1 text-[13px] text-k-ink-3">
					Choose a thread from the list, or press{" "}
					<kbd className="rounded border border-k-line-strong px-1.5 font-mono text-[11px]">C</kbd> to compose.
				</p>
			</div>
		</div>
	);
}
