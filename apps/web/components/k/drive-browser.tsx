"use client";
// Contents of a Drive folder (list or grid), large preview of supported files
// (the attachment viewer), action menus, empty state, and the volumes home page.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu } from "@mantine/core";
import { toast } from "sonner";
import { Download, Eye, Folder, FolderOpen, HardDrive, LayoutGrid, List, MoreVertical, Trash2, Upload } from "lucide-react";
import { deleteDriveEntry, getDriveDownloadUrl, getDriveViewUrls } from "@/lib/actions/drive";
import { getKind } from "@/components/mailbox/default/editor/editor-attachment-item";
import { badgeFor, PREVIEWABLE, Viewer } from "@/components/k/attachments";
import { formatBytes, listDate, fullDate } from "@/components/k/format";
import { driveCommand } from "@/components/k/drive-new";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import type { DriveState } from "@schema";

export type KDriveEntry = {
	id: string;
	name: string;
	type: "file" | "folder";
	sizeBytes: number;
	mimeType: string | null;
	lastModified: string | null;
};

function prettyName(name: string) {
	const s = (name ?? "").trim();
	try {
		return decodeURIComponent(s).replace(/\+/g, " ");
	} catch {
		return s.replace(/%20/g, " ").replace(/\+/g, " ");
	}
}

// Minimal record in the format expected by getKind / the attachment viewer.
function asAttachment(e: KDriveEntry, signedUrl: string) {
	return { id: e.id, filenameOriginal: prettyName(e.name), contentType: e.mimeType, sizeBytes: e.sizeBytes, signedUrl } as any;
}

function kindOf(e: KDriveEntry) {
	return getKind({ filenameOriginal: prettyName(e.name), contentType: e.mimeType } as any);
}

/** Type badge (or folder): "sm" size for the list, "lg" for the grid. */
function TypeMark({ entry, size }: { entry: KDriveEntry; size: "sm" | "lg" }) {
	if (entry.type === "folder") {
		return (
			<span
				className={`flex shrink-0 items-center justify-center rounded-k-sm bg-k-accent-soft text-k-accent-soft-ink ${
					size === "sm" ? "h-8 w-8" : "h-14 w-14 rounded-k"
				}`}
			>
				<Folder size={size === "sm" ? 17 : 28} />
			</span>
		);
	}
	const kind = kindOf(entry);
	const ext = (prettyName(entry.name).split(".").pop() || "").toUpperCase().slice(0, 4);
	// badgeFor leaves images in neutral grey: give them their own tint
	const badge = kind === "image" ? { label: ext || "IMG", color: "#0e8a7d" } : badgeFor(prettyName(entry.name), kind);
	return (
		<span
			className={`flex shrink-0 items-center justify-center font-bold tracking-wide text-white shadow-sm ${
				size === "sm" ? "h-8 w-8 rounded-[7px] text-[9.5px]" : "rounded-[8px] px-3 py-1.5 text-[13px]"
			}`}
			style={{ background: badge.color }}
		>
			{badge.label}
		</span>
	);
}

export function KDriveBrowser({ entries, volumeLabel }: { entries: KDriveEntry[]; volumeLabel: string }) {
	const pathname = (usePathname() ?? "").replace(/\/$/, "");
	const router = useRouter();
	const { state } = useDynamicContext<DriveState>();
	const [view, setView] = useState<"list" | "grid">("list");
	const [selected, setSelected] = useState<string | null>(null);
	const [toDelete, setToDelete] = useState<KDriveEntry | null>(null);
	const [urls, setUrls] = useState<Record<string, string>>({});
	const [open, setOpen] = useState<number | null>(null);

	useEffect(() => {
		try {
			const v = window.localStorage.getItem("k-drive-view");
			if (v === "grid" || v === "list") setView(v);
		} catch {}
	}, []);
	const changeView = (v: "list" | "grid") => {
		setView(v);
		try {
			window.localStorage.setItem("k-drive-view", v);
		} catch {}
	};

	// folders first, then alphabetical order
	const sorted = useMemo(
		() =>
			[...entries].sort(
				(a, b) =>
					Number(b.type === "folder") - Number(a.type === "folder") ||
					prettyName(a.name).localeCompare(prettyName(b.name), undefined, { numeric: true }),
			),
		[entries],
	);
	const folders = sorted.filter((e) => e.type === "folder").length;
	const files = sorted.length - folders;

	const previewable = useMemo(() => sorted.filter((e) => e.type === "file" && PREVIEWABLE.includes(kindOf(e))), [sorted]);
	const viewerFiles = useMemo(
		() => previewable.filter((e) => urls[e.id]).map((e) => asAttachment(e, urls[e.id])),
		[previewable, urls],
	);

	const download = useCallback(async (e: KDriveEntry) => {
		try {
			window.location.href = await getDriveDownloadUrl(e.id);
		} catch {
			toast.error("Download failed");
		}
	}, []);

	const preview = useCallback(
		async (e: KDriveEntry) => {
			let map = urls;
			if (!map[e.id]) {
				try {
					map = { ...urls, ...(await getDriveViewUrls(previewable.map((p) => p.id))) };
					setUrls(map);
				} catch {
					toast.error("The preview could not be loaded");
					return;
				}
			}
			const list = previewable.filter((p) => map[p.id]);
			const idx = list.findIndex((p) => p.id === e.id);
			if (idx >= 0) setOpen(idx);
		},
		[urls, previewable],
	);

	const activate = (e: KDriveEntry) => {
		if (e.type === "file") {
			if (PREVIEWABLE.includes(kindOf(e))) void preview(e);
			else void download(e);
		}
	};

	const confirmDelete = async () => {
		const e = toDelete;
		setToDelete(null);
		if (!e) return;
		const res = await deleteDriveEntry(e.id);
		if (res.success) {
			toast.success(e.type === "folder" ? "Folder deleted" : "File deleted");
			router.refresh();
		} else {
			toast.error("Deletion failed");
		}
	};

	const canUpload = !!state?.driveRouteContext?.driveVolume;

	if (sorted.length === 0) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
				<div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-k-hover text-k-ink-3">
					<FolderOpen size={26} />
				</div>
				<div>
					<p className="text-[15px] font-medium text-k-ink">This folder is empty</p>
					<p className="mx-auto mt-1 max-w-sm text-[13px] text-k-ink-3">
						Drag files here to upload them to {volumeLabel}, or use the button below.
					</p>
				</div>
				<button
					type="button"
					disabled={!canUpload}
					onClick={() => driveCommand("upload")}
					className="k-focus inline-flex h-9 items-center gap-2 rounded-k bg-k-accent px-4 text-[13.5px] font-medium text-k-accent-ink transition-colors hover:bg-k-accent-hover disabled:opacity-50"
				>
					<Upload size={15} /> Upload files
				</button>
			</div>
		);
	}

	const toggle =
		"flex h-7 w-7 items-center justify-center rounded-k-sm transition-colors";

	const menu = (e: KDriveEntry) => (
		<Menu shadow="md" width={190} position="bottom-end" withinPortal>
			<Menu.Target>
				<button
					type="button"
					aria-label={`Actions for ${prettyName(e.name)}`}
					onClick={(ev) => ev.stopPropagation()}
					className="k-focus flex h-8 w-8 shrink-0 items-center justify-center rounded-k-sm text-k-ink-3 transition-colors hover:bg-k-hover hover:text-k-ink"
				>
					<MoreVertical size={16} />
				</button>
			</Menu.Target>
			<Menu.Dropdown>
				{e.type === "folder" ? (
					<Menu.Item component={Link} href={`${pathname}/${encodeURIComponent(e.name)}`} leftSection={<FolderOpen size={15} />}>
						<span className="text-[13px]">Open</span>
					</Menu.Item>
				) : (
					<>
						{PREVIEWABLE.includes(kindOf(e)) && (
							<Menu.Item leftSection={<Eye size={15} />} onClick={() => void preview(e)}>
								<span className="text-[13px]">Preview</span>
							</Menu.Item>
						)}
						<Menu.Item leftSection={<Download size={15} />} onClick={() => void download(e)}>
							<span className="text-[13px]">Download</span>
						</Menu.Item>
					</>
				)}
				<Menu.Divider />
				<Menu.Item color="red" leftSection={<Trash2 size={15} />} onClick={() => setToDelete(e)}>
					<span className="text-[13px]">Delete</span>
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	);

	const nameClass = "truncate text-[13.5px] font-medium text-k-ink";
	const rowBase = (id: string) =>
		`group relative ${selected === id ? "bg-k-selected" : "hover:bg-k-hover"}`;

	const main = (e: KDriveEntry, children: React.ReactNode, className: string) =>
		e.type === "folder" ? (
			<Link
				href={`${pathname}/${encodeURIComponent(e.name)}`}
				onClick={() => setSelected(e.id)}
				title={prettyName(e.name)}
				className={`k-focus ${className}`}
			>
				{children}
			</Link>
		) : (
			<button
				type="button"
				onClick={() => {
					setSelected(e.id);
					activate(e);
				}}
				title={PREVIEWABLE.includes(kindOf(e)) ? `Preview ${prettyName(e.name)}` : `Download ${prettyName(e.name)}`}
				className={`k-focus text-left ${className}`}
			>
				{children}
			</button>
		);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 items-center gap-2 px-4 pb-1 pt-3 text-[12.5px] text-k-ink-3">
				<span className="flex-1">
					{[
						folders > 0 && `${folders} folder${folders > 1 ? "s" : ""}`,
						files > 0 && `${files} file${files > 1 ? "s" : ""}`,
					]
						.filter(Boolean)
						.join(" · ")}
				</span>
				<div role="group" aria-label="View" className="flex items-center gap-0.5 rounded-k bg-k-hover p-0.5">
					<button
						type="button"
						aria-label="List view"
						aria-pressed={view === "list"}
						onClick={() => changeView("list")}
						className={`${toggle} ${view === "list" ? "bg-k-surface text-k-ink shadow-k-pane" : "text-k-ink-3 hover:text-k-ink"}`}
					>
						<List size={15} />
					</button>
					<button
						type="button"
						aria-label="Grid view"
						aria-pressed={view === "grid"}
						onClick={() => changeView("grid")}
						className={`${toggle} ${view === "grid" ? "bg-k-surface text-k-ink shadow-k-pane" : "text-k-ink-3 hover:text-k-ink"}`}
					>
						<LayoutGrid size={15} />
					</button>
				</div>
			</div>

			{view === "list" ? (
				<div role="list" className="px-2 pb-4 md:px-3">
					<div className="hidden items-center gap-3 border-b border-k-line px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-k-ink-3 sm:flex">
						<span className="flex-1">Name</span>
						<span className="w-28 text-right max-md:hidden">Modified</span>
						<span className="w-20 text-right">Size</span>
						<span className="w-8" />
					</div>
					{sorted.map((e) => (
						<div key={e.id} role="listitem" className={`${rowBase(e.id)} flex items-center rounded-k-sm pr-1`}>
							{main(
								e,
								<>
									<TypeMark entry={e} size="sm" />
									<span className="min-w-0 flex-1">
										<span className={`block ${nameClass}`}>{prettyName(e.name)}</span>
										<span className="block truncate text-[12px] text-k-ink-3 sm:hidden">
											{[e.type === "file" ? formatBytes(e.sizeBytes) : null, e.lastModified ? listDate(e.lastModified) : null]
												.filter(Boolean)
												.join(" · ")}
										</span>
									</span>
									<span
										className="w-28 shrink-0 text-right text-[12.5px] text-k-ink-3 max-md:hidden"
										title={e.lastModified ? fullDate(e.lastModified) : undefined}
									>
										{e.lastModified ? listDate(e.lastModified) : "—"}
									</span>
									<span className="w-20 shrink-0 text-right text-[12.5px] tabular-nums text-k-ink-3 max-sm:hidden">
										{e.type === "file" ? formatBytes(e.sizeBytes) || "—" : "—"}
									</span>
								</>,
								"flex min-w-0 flex-1 items-center gap-3 rounded-k-sm px-3 py-2",
							)}
							{menu(e)}
						</div>
					))}
				</div>
			) : (
				<div role="list" className="grid gap-2.5 px-4 pb-4 pt-2 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
					{sorted.map((e) => (
						<div
							key={e.id}
							role="listitem"
							className={`${rowBase(e.id)} overflow-hidden rounded-k border ${
								selected === e.id ? "border-k-accent" : "border-k-line hover:border-k-line-strong"
							} bg-k-surface transition-[border-color,box-shadow] hover:shadow-k-pane`}
						>
							{main(
								e,
								<>
									<span className="flex h-[92px] items-center justify-center bg-k-surface-2">
										<TypeMark entry={e} size="lg" />
									</span>
									<span className="block min-w-0 px-2.5 py-2 pr-9">
										<span className={`block ${nameClass}`}>{prettyName(e.name)}</span>
										<span className="block truncate text-[11.5px] text-k-ink-3">
											{[e.type === "file" ? formatBytes(e.sizeBytes) : "Folder", e.lastModified ? listDate(e.lastModified) : null]
												.filter(Boolean)
												.join(" · ")}
										</span>
									</span>
								</>,
								"block w-full",
							)}
							<div className="absolute bottom-1.5 right-1">{menu(e)}</div>
						</div>
					))}
				</div>
			)}

			{open !== null && viewerFiles.length > 0 && (
				<Viewer files={viewerFiles} index={Math.min(open, viewerFiles.length - 1)} onIndex={setOpen} onClose={() => setOpen(null)} />
			)}

			<AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Delete "{toDelete ? prettyName(toDelete.name) : ""}"?</AlertDialogTitle>
						<AlertDialogDescription>
							{toDelete?.type === "folder"
								? "The folder and all its contents will be permanently deleted. This action cannot be undone."
								: "The file will be permanently deleted. This action cannot be undone."}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

export type KVolumeCard = { id: string; publicId: string; label: string; kind: string };

/** Drive home: the user's volumes, or an empty state explaining how to add one. */
export function KDriveVolumes({ volumes, workspacePublicId }: { volumes: KVolumeCard[]; workspacePublicId: string }) {
	if (volumes.length === 0) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
				<div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-k-hover text-k-ink-3">
					<HardDrive size={26} />
				</div>
				<div>
					<p className="text-[15px] font-medium text-k-ink">No storage volumes</p>
					<p className="mx-auto mt-1 max-w-sm text-[13px] text-k-ink-3">
						A volume is a storage space where you keep and share your files. Add one from Platform, under
												Storage, to start uploading files.
					</p>
				</div>
				<Link
					href={`/w/${workspacePublicId}/dashboard/platform/storage`}
					className="k-focus inline-flex h-9 items-center gap-2 rounded-k bg-k-accent px-4 text-[13.5px] font-medium text-k-accent-ink transition-colors hover:bg-k-accent-hover"
				>
					Open storage
				</Link>
			</div>
		);
	}
	return (
		<div className="px-4 py-4">
			<p className="mb-3 text-[13px] text-k-ink-3">Choose a volume to browse its files.</p>
			<div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
				{volumes.map((v) => (
					<Link
						key={v.id}
						href={`/w/${workspacePublicId}/dashboard/drive/volumes/${v.publicId}`}
						className="k-focus flex items-center gap-3 rounded-k border border-k-line bg-k-surface p-3.5 transition-[border-color,box-shadow] hover:border-k-line-strong hover:shadow-k-pane"
					>
						<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-k-sm bg-k-accent-soft text-k-accent-soft-ink">
							<HardDrive size={19} />
						</span>
						<span className="min-w-0">
							<span className="block truncate text-[14px] font-medium text-k-ink">{v.label}</span>
							<span className="block text-[12px] text-k-ink-3">{v.kind === "cloud" ? "Cloud storage" : v.kind}</span>
						</span>
					</Link>
				))}
			</div>
		</div>
	);
}
