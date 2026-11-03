"use client";
// ss2i : navigation laterale de la section Plateforme (nouvelle interface),
// au style de la barre laterale de la messagerie.
import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Blocks, FolderSync, HardDrive, Key, LayoutDashboard, Plug, Send, Webhook } from "lucide-react";
import { cn } from "@/lib/utils";

export default function KPlatformNav({
	workspacePublicId,
	workspaceRole,
}: {
	workspacePublicId?: string;
	workspaceRole?: string;
}) {
	const pathname = usePathname() ?? "";
	const base = `/w/${workspacePublicId}/dashboard/platform`;
	const owner = workspaceRole === "owner";

	const general = [{ href: `${base}/overview`, label: "Vue d'ensemble", icon: LayoutDashboard }];
	const config = [
		{ href: `${base}/providers`, label: "Fournisseurs", icon: Plug },
		{ href: `${base}/identities`, label: "Identités", icon: Send },
		{ href: `${base}/workspace`, label: "Espace de travail", icon: Blocks },
		{ href: `${base}/storage`, label: "Stockage", icon: HardDrive },
	];
	const dev = [
		{ href: `${base}/api-keys`, label: "Clés d'API", icon: Key },
		{ href: `${base}/webhooks`, label: "Webhooks", icon: Webhook },
		{ href: `${base}/sync-services`, label: "Services de synchronisation", icon: FolderSync },
	];

	const Item = ({ href, label, icon: Icon }: { href: string; label: string; icon: React.ElementType }) => {
		const active = pathname === href || pathname.startsWith(`${href}/`);
		return (
			<Link
				href={href}
				aria-current={active ? "page" : undefined}
				className={cn(
					"flex items-center gap-2.5 rounded-k-sm px-2.5 py-[7px] text-[13.5px] transition-colors",
					active
						? "bg-k-surface font-medium text-k-ink shadow-k-pane"
						: "text-k-ink-2 hover:bg-k-hover hover:text-k-ink",
				)}
			>
				<Icon className={cn("h-4 w-4 shrink-0", active ? "text-k-accent" : "text-k-ink-3")} />
				<span className="leading-snug">{label}</span>
			</Link>
		);
	};
	const Label = ({ children }: { children: React.ReactNode }) => (
		<div className="mb-1 px-2.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3">{children}</div>
	);

	return (
		<nav aria-label="Plateforme" className="space-y-5">
			<div className="space-y-px">
				{general.map((i) => (
					<Item key={i.href} {...i} />
				))}
			</div>
			{owner && (
				<>
					<div>
						<Label>Configuration</Label>
						<div className="space-y-px">
							{config.map((i) => (
								<Item key={i.href} {...i} />
							))}
						</div>
					</div>
					<div>
						<Label>Intégrations</Label>
						<div className="space-y-px">
							{dev.map((i) => (
								<Item key={i.href} {...i} />
							))}
						</div>
					</div>
				</>
			)}
		</nav>
	);
}
