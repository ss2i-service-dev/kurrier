"use client";
import React from "react";
import { usePathname } from "next/navigation";
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
	if (!/\/threads\/[^/]+/.test(pathname ?? "")) return null;
	if (!unreadPanel) return <>{children}</>;
	return (
		<div className="flex items-start">
			<div className="min-w-0 flex-1" data-k-thread-column="">
				{children}
			</div>
			<UnreadPanel identityPublicId={unreadPanel.identityPublicId} mailboxSlug={unreadPanel.mailboxSlug} />
		</div>
	);
}
