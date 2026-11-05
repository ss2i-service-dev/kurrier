"use client";
// Navigation of the Drive section (modern sidebar): all volumes, then the
// list of the user's cloud volumes.
import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Cloud, HardDrive, LayoutGrid } from "lucide-react";

export type KVolume = { id: string; publicId: string; label: string };

function Item({ href, active, icon, label }: { href: string; active: boolean; icon: React.ReactNode; label: string }) {
	return (
		<Link
			href={href}
			aria-current={active ? "page" : undefined}
			className={`flex items-center gap-2.5 rounded-k-sm px-2.5 py-[7px] text-[13.5px] transition-colors ${
				active ? "bg-k-surface font-medium text-k-ink shadow-k-pane" : "text-k-ink-2 hover:bg-k-hover hover:text-k-ink"
			}`}
		>
			<span className={`shrink-0 ${active ? "text-k-accent" : "text-k-ink-3"}`}>{icon}</span>
			<span className="flex-1 truncate">{label}</span>
		</Link>
	);
}

export default function KDriveNav({
	workspacePublicId,
	volumes,
}: {
	workspacePublicId: string;
	volumes: KVolume[];
}) {
	const pathname = (usePathname() ?? "").replace(/\/$/, "");
	const base = `/w/${workspacePublicId}/dashboard/drive`;

	return (
		<nav aria-label="Drive" className="space-y-5">
			<div className="space-y-px">
				<Item href={base} active={pathname.endsWith("/dashboard/drive")} icon={<LayoutGrid className="h-4 w-4" />} label="All volumes" />
			</div>

			<div>
				<div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3">Volumes</div>
				<div className="space-y-px">
					{volumes.length === 0 && <p className="px-2.5 py-1 text-[12.5px] text-k-ink-3">No volumes</p>}
					{volumes.map((v) => {
						const href = `${base}/volumes/${v.publicId}`;
						// the browser path may carry the language prefix
						const mark = `/volumes/${v.publicId}`;
						return (
							<Item
								key={v.id}
								href={href}
								active={pathname.endsWith(mark) || pathname.includes(mark + "/")}
								icon={<HardDrive className="h-4 w-4" />}
								label={v.label}
							/>
						);
					})}
				</div>
			</div>

			<p className="flex items-start gap-2 px-2.5 text-[12px] leading-snug text-k-ink-3">
				<Cloud className="mt-px h-3.5 w-3.5 shrink-0" />
				<span>Volumes are managed in Platform, under Storage.</span>
			</p>
		</nav>
	);
}
