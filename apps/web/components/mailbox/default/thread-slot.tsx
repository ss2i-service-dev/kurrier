"use client";
import React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { leaveThreadToList } from "@/lib/leave-thread";
import UnreadPanel from "@/components/mailbox/default/unread-panel";

// The open thread is rendered in the "@thread" parallel route. On soft
// navigation (clicking Inbox in the sidebar), Next keeps that route's content
// until another segment replaces it, so the message stayed displayed above the
// list. The thread is only rendered when the URL carries one.
//
// Rely on the PATH, not on useParams: in the preserved slot, useParams still
// returns the old threadId although the URL has changed.
//
// With the "Unread messages panel" option (unreadPanel set), the thread sits in
// a flexible column with the unread panel on its right; without the option,
// nothing changes.
export default function ThreadSlot({
	children,
	unreadPanel,
}: {
	children: React.ReactNode;
	unreadPanel?: { identityPublicId: string; mailboxSlug: string } | null;
}) {
	const pathname = usePathname();
	const router = useRouter();
	if (!/\/threads\/[^/]+/.test(pathname ?? "")) return null;
	// On mobile, no way back to the list from a thread except the phone's Back button:
	// back bar stuck under the top bar.
	const back = (
		<div className="sticky top-[var(--mail-header-h,0px)] z-40 border-b bg-background/95 px-2 py-1 backdrop-blur md:hidden" data-thread-back="">
			<button
				type="button"
				onClick={() => leaveThreadToList(router, pathname ?? "")}
				className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted"
			>
				<ArrowLeft className="h-4 w-4" />
				Back
			</button>
		</div>
	);
	if (!unreadPanel) return <>{back}{children}</>;
	return (
		<>
		{back}
		<div className="flex items-start">
			<div className="min-w-0 flex-1" data-k-thread-column="">
				{children}
			</div>
			<UnreadPanel identityPublicId={unreadPanel.identityPublicId} mailboxSlug={unreadPanel.mailboxSlug} />
		</div>
		</>
	);
}
