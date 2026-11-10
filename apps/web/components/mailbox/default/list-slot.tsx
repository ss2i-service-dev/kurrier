"use client";
import React from "react";
import { usePathname } from "next/navigation";
import { listIsHidden, type ListUnderThread } from "@/lib/list-under-thread";

// On soft navigation, the folder page (the list) stays displayed under the open thread of the
// "@thread" slot, and the thread, often the most recent one, appeared twice. With the "hidden"
// option, the list is not rendered while the URL carries a thread; it comes back as soon as
// the URL no longer has one (back, click on the folder, closing the thread).
//
// Same path test as ThreadSlot (usePathname, not useParams: in a preserved slot, useParams
// still returns the old threadId).
export default function ListSlot({
	mode,
	children,
}: {
	mode: ListUnderThread;
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	if (listIsHidden(mode, pathname)) return null;
	return <>{children}</>;
}
