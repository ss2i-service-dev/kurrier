"use client";
// Identity settings screen. Title, side navigation of the sections in the
// sidebar style, content in cards.
import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Ban, Cog, Filter, Keyboard, Reply } from "lucide-react";
import MobileNavButton from "@/components/k/mobile-nav-button";

export default function KSettingsShell({
	identityLabel,
	identityPublicId,
	workspacePublicId,
	children,
}: {
	identityLabel?: string;
	identityPublicId: string;
	workspacePublicId: string;
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	const base = `/w/${workspacePublicId}/dashboard/mail/${identityPublicId}/settings`;
	const sections = [
		{ href: base, label: "General", icon: Cog },
		{ href: `${base}/rules`, label: "Rules", icon: Filter },
		{ href: `${base}/autoreply`, label: "Auto-reply", icon: Reply },
		{ href: `${base}/blocked`, label: "Blocked senders", icon: Ban },
		{ href: `${base}/shortcuts`, label: "Keyboard shortcuts", icon: Keyboard },
	];
	const current = (pathname ?? "").replace(/\/$/, "");

	return (
		<div className="flex min-h-0 flex-1 flex-col md:flex-row">
			<aside className="shrink-0 border-b border-k-line md:w-60 md:border-b-0 md:border-r md:px-3 md:py-5">
				<div className="flex items-center gap-2 px-3 pt-3 md:px-2.5 md:pt-0">
					<MobileNavButton />
					<div className="min-w-0">
						<h1 className="text-[17px] font-semibold tracking-tight text-k-ink">Settings</h1>
						{identityLabel && <p className="truncate text-[12.5px] text-k-ink-3">{identityLabel}</p>}
					</div>
				</div>
				<nav
					aria-label="Settings sections"
					className="k-scroll flex gap-1 overflow-x-auto px-3 py-2 md:mt-4 md:flex-col md:gap-px md:overflow-visible md:px-0 md:py-0"
				>
					{sections.map((s) => {
						const active = current === s.href;
						return (
							<Link
								key={s.href}
								href={s.href}
								aria-current={active ? "page" : undefined}
								className={`flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-k-sm px-2.5 py-[7px] text-[13.5px] transition-colors ${
									active
										? "bg-k-selected font-medium text-k-ink"
										: "text-k-ink-2 hover:bg-k-hover hover:text-k-ink"
								}`}
							>
								<s.icon size={16} className={active ? "text-k-accent" : "text-k-ink-3"} />
								{s.label}
							</Link>
						);
					})}
				</nav>
			</aside>
			<div className="k-scroll min-w-0 flex-1 overflow-y-auto bg-k-surface-2/60">
				<div className="k-fade-in space-y-4 px-4 py-5 md:px-8 md:py-7">{children}</div>
			</div>
		</div>
	);
}
