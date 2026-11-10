"use client";
import { useStripSubjectPrefixes } from "@/components/mailbox/default/compose-style-context";
import { subjectForDisplay } from "@common/subject";
import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMediaQuery } from "@mantine/hooks";
import { Paperclip } from "lucide-react";
import { useShowSnippet } from "@/components/mailbox/default/list-preview-context";
import { fetchUnreadPanelThreads } from "@/lib/actions/unread-panel";
import type { UnreadPanelThread } from "@/lib/actions/unread-panel";
import { useHiddenThreads } from "@/lib/pending-moves";

// Side panel listing the unread threads of the current folder, next to the open
// thread (per-user option, see thread-slot.tsx). The open thread stays listed
// even once read; the others leave the list at the next refresh (thread
// change, tab focus, every 60 s).

const REFRESH_MS = 60_000;

function senderLabel(t: UnreadPanelThread, mailboxSlug: string) {
	const p = t.participants ?? {};
	// In Sent, the recipient is more telling than the sender.
	const list = (mailboxSlug === "sent" ? p.to : p.from) ?? p.from ?? p.to ?? [];
	const first = list.find((x) => x?.e);
	if (!first) return "Unknown sender";
	return (first.n && first.n.trim()) || first.e;
}

function whenLabel(iso: string | null) {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	if (sameDay) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	if (d.getFullYear() === now.getFullYear()) {
		return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function UnreadPanel({
	identityPublicId,
	mailboxSlug,
}: {
	identityPublicId: string;
	mailboxSlug: string;
}) {
	const stripPrefixes = useStripSubjectPrefixes();
	const pathname = usePathname() ?? "";
	const currentThreadId = pathname.match(/\/threads\/([^/?#]+)/)?.[1] ?? null;
	// The panel is hidden in CSS below 1280 px; also avoid loading its data there.
	const isWide = useMediaQuery("(min-width: 1280px)");
	const isHidden = useHiddenThreads();
	const showSnippet = useShowSnippet();

	const [threads, setThreads] = useState<UnreadPanelThread[] | null>(null);
	const currentRef = useRef<HTMLLIElement>(null);
	const requestRef = useRef(0);

	const refresh = useCallback(async () => {
		const seq = ++requestRef.current;
		try {
			const rows = await fetchUnreadPanelThreads(identityPublicId, mailboxSlug, currentThreadId);
			// A response superseded by a more recent request is ignored.
			if (seq === requestRef.current) setThreads(rows);
		} catch {
			if (seq === requestRef.current) setThreads((prev) => prev ?? []);
		}
	}, [identityPublicId, mailboxSlug, currentThreadId]);

	useEffect(() => {
		if (!isWide) return;
		refresh();
		const onVisible = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("focus", refresh);
		const timer = setInterval(refresh, REFRESH_MS);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", refresh);
			clearInterval(timer);
		};
	}, [isWide, refresh]);

	useEffect(() => {
		currentRef.current?.scrollIntoView({ block: "nearest" });
	}, [currentThreadId, threads]);

	const visible = (threads ?? []).filter((t) => !isHidden(String(t.mailboxId), String(t.threadId)));
	const unreadTotal = visible.filter((t) => t.unreadCount > 0).length;
	const hrefFor = (threadId: string) => pathname.replace(/\/threads\/[^/?#]+.*$/, `/threads/${threadId}`);

	return (
		<aside
			aria-label="Unread messages"
			className="sticky top-[4.5rem] mr-4 mt-4 hidden max-h-[calc(100vh-5.5rem)] w-[320px] shrink-0 flex-col overflow-hidden rounded-xl border bg-background/50 xl:flex lg:mr-8"
		>
			<div className="flex items-center justify-between border-b px-4 py-3">
				<span className="text-sm font-semibold">Unread</span>
				<span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">
					{threads === null ? "…" : unreadTotal}
				</span>
			</div>

			{threads !== null && visible.length === 0 ? (
				<div className="p-6 text-center text-sm text-muted-foreground">No unread messages</div>
			) : (
				<ul role="list" className="divide-y overflow-y-auto">
					{visible.map((t) => {
						const isCurrent = String(t.threadId) === currentThreadId;
						const isUnread = t.unreadCount > 0;
						return (
							<li key={String(t.threadId)} ref={isCurrent ? currentRef : undefined}>
								<Link
									href={hrefFor(String(t.threadId))}
									prefetch={false}
									aria-current={isCurrent ? "page" : undefined}
									className={[
										"block border-l-2 px-3 py-2.5 transition-colors hover:bg-muted/60",
										isCurrent ? "border-l-primary bg-muted/40" : "border-l-transparent",
									].join(" ")}
								>
									<div className="flex items-baseline justify-between gap-2">
										<span className={`truncate text-sm ${isUnread ? "font-semibold" : "text-muted-foreground"}`}>
											{senderLabel(t, mailboxSlug)}
										</span>
										<span className="shrink-0 text-xs tabular-nums text-muted-foreground">
											{whenLabel(t.lastActivityAt)}
										</span>
									</div>
									<div className="mt-0.5 flex items-center gap-1">
										<span className={`truncate text-sm ${isUnread ? "font-medium" : "text-muted-foreground"}`}>
											{subjectForDisplay(t.subject?.trim(), stripPrefixes) || "(no subject)"}
										</span>
										{t.messageCount > 1 && (
											<span className="shrink-0 text-xs text-muted-foreground">({t.messageCount})</span>
										)}
										{t.hasAttachments && <Paperclip className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
									</div>
									{showSnippet && t.previewText?.trim() && (
										<p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
											{t.previewText.trim()}
										</p>
									)}
								</Link>
							</li>
						);
					})}
				</ul>
			)}
		</aside>
	);
}
