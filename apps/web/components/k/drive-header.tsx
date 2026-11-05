"use client";
// Header of the Drive section: breadcrumb, upload and new folder.
// Also publishes the route context to the Drive state (like DriveTopBar in the
// classic interface), which the "New" button and the uploader depend on.
import React, { useEffect } from "react";
import Link from "next/link";
import { ChevronRight, FolderPlus, Upload } from "lucide-react";
import type { DriveRouteContext, DriveState } from "@schema";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import MobileNavButton from "@/components/k/mobile-nav-button";
import { driveCommand } from "@/components/k/drive-new";

export default function KDriveHeader({
	ctx,
	userId,
	workspacePublicId,
}: {
	ctx: DriveRouteContext;
	userId: string;
	workspacePublicId: string;
}) {
	const { setState } = useDynamicContext<DriveState>();

	useEffect(() => {
		setState((prev) => ({ ...prev, driveRouteContext: ctx, userId }));
	}, [ctx, userId, setState]);

	const root = `/w/${workspacePublicId}/dashboard/drive`;
	const vol = ctx.driveVolume;
	const crumbs: { label: string; href: string }[] = [{ label: "Drive", href: root }];
	if (vol) {
		const volHref = `${root}/volumes/${encodeURIComponent(vol.publicId)}`;
		crumbs.push({ label: vol.label || vol.code || "Volume", href: volHref });
		const acc: string[] = [];
		for (const seg of ctx.within) {
			acc.push(encodeURIComponent(seg));
			crumbs.push({ label: seg, href: `${volHref}/${acc.join("/")}` });
		}
	}

	const btn =
		"k-focus inline-flex h-8 shrink-0 items-center gap-1.5 rounded-k-sm px-2.5 text-[13px] font-medium text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink";

	return (
		<div className="sticky top-0 z-10 flex h-[52px] shrink-0 items-center gap-2 border-b bg-k-surface border-k-line px-3 md:px-4">
			<MobileNavButton />
			<nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center">
				{crumbs.map((c, i) => {
					const last = i === crumbs.length - 1;
					// on mobile, only the last two levels stay visible
					const hideSmall = i < crumbs.length - 2;
					return (
						<React.Fragment key={c.href}>
							{i > 0 && (
								<ChevronRight
									size={14}
									className={`mx-0.5 shrink-0 text-k-ink-3 ${hideSmall ? "max-md:hidden" : ""}`}
									aria-hidden
								/>
							)}
							{last ? (
								<h1 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em] text-k-ink" title={c.label}>
									{c.label}
								</h1>
							) : (
								<Link
									href={c.href}
									className={`max-w-[200px] shrink truncate rounded-k-sm px-1.5 py-0.5 text-[14px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink ${
										hideSmall ? "max-md:hidden" : ""
									}`}
								>
									{c.label}
								</Link>
							)}
						</React.Fragment>
					);
				})}
			</nav>
			{vol && ctx.scope === "cloud" && (
				<div className="flex shrink-0 items-center gap-1">
					<button type="button" className={btn} onClick={() => driveCommand("upload")}>
						<Upload size={15} />
						<span className="max-sm:hidden">Upload</span>
					</button>
					<button type="button" className={btn} onClick={() => driveCommand("folder")}>
						<FolderPlus size={15} />
						<span className="max-sm:hidden">New folder</span>
					</button>
				</div>
			)}
		</div>
	);
}
