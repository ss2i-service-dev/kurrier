// Shared building blocks for screens outside the list/reader layout
// (snoozed, scheduled sends, search results, labels).
import React from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import MobileNavButton from "@/components/k/mobile-nav-button";

/** Section header: title, subtitle (counter...) and an actions area on the right. */
export function KSectionHeader({
	title,
	subtitle,
	actions,
	mobileNav = true,
}: {
	title: React.ReactNode;
	subtitle?: React.ReactNode;
	actions?: React.ReactNode;
	mobileNav?: boolean;
}) {
	return (
		<div className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-4">
			{mobileNav && <MobileNavButton />}
			<div className="min-w-0 flex-1">
				<h1 className="truncate text-[17px] font-semibold tracking-tight text-k-ink">{title}</h1>
				{subtitle && <p className="mt-0.5 truncate text-[12.5px] text-k-ink-3">{subtitle}</p>}
			</div>
			{actions}
		</div>
	);
}

/** Empty state: icon badge, title, explanation. */
export function KEmptyState({
	icon,
	title,
	text,
}: {
	icon: React.ReactNode;
	title: string;
	text?: React.ReactNode;
}) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
			<div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-k-hover text-k-ink-3">{icon}</div>
			<p className="text-[14px] font-medium text-k-ink">{title}</p>
			{text && <p className="max-w-sm text-[13px] text-k-ink-3">{text}</p>}
		</div>
	);
}

/** Link-based pagination (previous / next): href(page) returns the URL of a page. */
export function KPager({
	page,
	total,
	pageSize,
	href,
}: {
	page: number;
	total: number;
	pageSize: number;
	href: (page: number) => string;
}) {
	const pages = Math.max(1, Math.ceil(total / pageSize));
	if (pages <= 1) return null;
	const first = (page - 1) * pageSize + 1;
	const last = Math.min(page * pageSize, total);
	const btn =
		"flex h-7 w-7 items-center justify-center rounded-k-sm text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink";
	const off = "pointer-events-none opacity-30";
	return (
		<div className="sticky bottom-0 mt-auto flex items-center justify-end gap-1 border-t border-k-line bg-k-surface px-3 py-1.5 text-[12px] text-k-ink-3">
			<span className="mr-2 tabular-nums">
				{first}–{last} of {total}
			</span>
			<Link href={href(Math.max(1, page - 1))} className={`${btn} ${page <= 1 ? off : ""}`} aria-label="Previous page" aria-disabled={page <= 1}>
				<ChevronLeft size={15} />
			</Link>
			<Link href={href(Math.min(pages, page + 1))} className={`${btn} ${page >= pages ? off : ""}`} aria-label="Next page" aria-disabled={page >= pages}>
				<ChevronRight size={15} />
			</Link>
		</div>
	);
}
