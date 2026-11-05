"use client";
// Navigation of the Contacts section (modern sidebar): all contacts, address
// books, then labels (KLabels).
import React, { useEffect } from "react";
import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { BookUser, Users } from "lucide-react";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import KLabels from "@/components/k/labels";
import { LabelEntity } from "@db";

type LabelWithCount = LabelEntity & { contactCount?: number };
export type KBook = { id: string; name: string; count: number };

function Item({
	href,
	active,
	icon,
	label,
	count,
}: {
	href: string;
	active: boolean;
	icon: React.ReactNode;
	label: string;
	count?: number;
}) {
	return (
		<Link
			href={href}
			aria-current={active ? "page" : undefined}
			className={`flex items-center gap-2.5 rounded-k-sm px-2.5 py-[7px] text-[13.5px] transition-colors ${
				active ? "bg-k-surface font-medium text-k-ink shadow-k-pane" : "text-k-ink-2 hover:bg-k-hover hover:text-k-ink"
			}`}
		>
			<span className={active ? "text-k-accent" : "text-k-ink-3"}>{icon}</span>
			<span className="flex-1 truncate">{label}</span>
			{count !== undefined && <span className="text-[12px] tabular-nums text-k-ink-3">{count}</span>}
		</Link>
	);
}

export default function KContactsNav({
	workspacePublicId,
	books,
	total,
	globalLabels,
}: {
	workspacePublicId: string;
	books: KBook[];
	total: number;
	globalLabels: LabelWithCount[];
}) {
	const pathname = usePathname() ?? "";
	const params = useParams() as { labelSlug?: string };
	const bookId = useSearchParams().get("book");
	const { setState } = useDynamicContext();
	const base = `/w/${workspacePublicId}/dashboard/contacts`;

	// Same synchronization as render-contacts-label-home-sidebar.tsx
	useEffect(() => {
		setState((prev) => ({ ...prev, labels: globalLabels }));
	}, [globalLabels, setState]);

	const onAll = !params.labelSlug && !bookId && !pathname.endsWith("/new");

	return (
		<nav aria-label="Contacts" className="space-y-5">
			<div className="space-y-px">
				<Item href={base} active={onAll} icon={<Users className="h-4 w-4" />} label="All contacts" count={total} />
			</div>

			<div>
				<div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3">
					Address books
				</div>
				<div className="space-y-px">
					{books.length === 0 && <p className="px-2.5 py-1 text-[12.5px] text-k-ink-3">No address books</p>}
					{books.map((b) => (
						<Item
							key={b.id}
							href={`${base}?book=${b.id}`}
							active={bookId === b.id && !params.labelSlug}
							icon={<BookUser className="h-4 w-4" />}
							label={b.name}
							count={b.count}
						/>
					))}
				</div>
			</div>

			<KLabels />
		</nav>
	);
}
