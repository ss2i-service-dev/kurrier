"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import React, {use, useEffect, useState} from "react";
import { Pagination } from "@mantine/core";
import { useParams, usePathname, useRouter } from "next/navigation";
import {FetchMailboxResult} from "@/lib/actions/mailbox";

// Compact pagination (1–50 of N, previous / next).
function KPagination({
	// count,
	// mailboxSlug,
	workspacePublicId,
	identityPublicId,
	fetchMailboxPromise,
	page
}: {
	// count: number;
	// mailboxSlug: string | null;
	workspacePublicId: string;
	identityPublicId: string;
	fetchMailboxPromise: Promise<FetchMailboxResult>;
	page?: number;
}) {
	const {count, activeMailbox} = use(fetchMailboxPromise)
	const mailboxSlug = activeMailbox?.slug || null;
	const [activePage, setPage] = useState(page || 1);
	const router = useRouter();
	const pathname = usePathname();
	const params = useParams();

	const updatePageNumber = async (number: number) => {
		if (number < 1) return;
		if (Number(number) === 1) {
			setPage(1);
			router.push(
				`/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${mailboxSlug}`,
			);
			return;
		}
		router.push(
			`/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/${mailboxSlug}?page=${number}`,
		);
		setPage(number);
	};

	const total = Math.ceil((count ?? 0) / 50);
	if (total <= 1) return null;
	const first = (activePage - 1) * 50 + 1;
	const last = Math.min(activePage * 50, count);
	const btn =
		"flex h-7 w-7 items-center justify-center rounded-k-sm text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink disabled:pointer-events-none disabled:opacity-30";

	return (
		<div className="sticky bottom-0 mt-auto flex items-center justify-end gap-1 border-t border-k-line bg-k-surface px-3 py-1.5 text-[12px] text-k-ink-3">
			<span className="mr-2 tabular-nums">
				{first}–{last} of {count}
			</span>
			<button type="button" className={btn} disabled={activePage <= 1} onClick={() => updatePageNumber(activePage - 1)} aria-label="Previous page">
				<ChevronLeft size={15} />
			</button>
			<button type="button" className={btn} disabled={activePage >= total} onClick={() => updatePageNumber(activePage + 1)} aria-label="Next page">
				<ChevronRight size={15} />
			</button>
		</div>
	);
}

export default KPagination;
