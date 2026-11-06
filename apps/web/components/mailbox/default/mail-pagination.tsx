"use client";
import React, {use, useEffect, useState} from "react";
import { Pagination } from "@mantine/core";
import { usePathname, useRouter } from "next/navigation";
import {FetchMailboxResult} from "@/lib/actions/mailbox";
import { PAGE_SIZE } from "@common/mail-client";
import { clampPage, pageCount } from "@/lib/mail-pagination";

function MailPagination({
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
	// ss2i : nombre de pages entier sur les fils visibles (le quotient brut laissait 0,04 page :
	// fleche suivante active qui ne menait nulle part). Derniere page -> fleche grisee.
	const total = pageCount(count, PAGE_SIZE);
	const [activePage, setPage] = useState(clampPage(page || 1, total));
	const router = useRouter();
	const pathname = usePathname();
	// ss2i : chemin reel de l'URL, useParams garde l'ancien threadId (route parallele @thread conservee).
	const onThread = /\/threads\/[^/]+/.test(pathname ?? "");

	const updatePageNumber = async (number: number) => {
		if (number < 1 || number > total) return;
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

	return (
		<div className={onThread ? "hidden" : ""}>
			<Pagination
				value={activePage}
				onChange={updatePageNumber}
				total={total}
			/>
		</div>
	);
}

export default MailPagination;
