"use client";
// Attachments under an open message, as thumbnails, with a large preview
// (images, PDF, text, video, audio) in a full-screen viewer: arrows to move
// between files, Esc to close. Same rule as message-attachments.tsx: images
// already displayed in the message body (inline) are not repeated.
import React, { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, Eye, Paperclip, X } from "lucide-react";
import { getKind } from "@/components/mailbox/default/editor/editor-attachment-item";
import type { MessageAttachmentWithUrl } from "@/components/mailbox/default/email-renderer";
import { formatBytes } from "@/components/k/format";

type Kind = ReturnType<typeof getKind>;
export const PREVIEWABLE: Kind[] = ["image", "pdf", "text", "video", "audio"];

// Type badge: colour and abbreviation per file family.
export function badgeFor(name: string, kind: Kind) {
	const ext = (name.split(".").pop() || "").toLowerCase();
	if (kind === "pdf") return { label: "PDF", color: "#d0453b" };
	if (["doc", "docx", "odt", "rtf"].includes(ext)) return { label: "DOC", color: "#2f5bd3" };
	if (["xls", "xlsx", "ods", "csv"].includes(ext)) return { label: ext === "csv" ? "CSV" : "XLS", color: "#1f8a4c" };
	if (["ppt", "pptx", "odp", "key"].includes(ext)) return { label: "PPT", color: "#d5651b" };
	if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return { label: "ZIP", color: "#7a6a52" };
	if (kind === "video") return { label: "VID", color: "#7b3fb8" };
	if (kind === "audio") return { label: "AUD", color: "#b8337a" };
	if (kind === "calendar") return { label: "ICS", color: "#1e7a8c" };
	if (kind === "text") return { label: ext.toUpperCase().slice(0, 4) || "TXT", color: "#57534e" };
	return { label: (ext || "FILE").toUpperCase().slice(0, 4), color: "#8c877f" };
}

export default function KAttachments({
	attachments,
	hiddenIds = [],
}: {
	attachments: MessageAttachmentWithUrl[];
	hiddenIds?: string[];
}) {
	const files = (attachments ?? []).filter((a) => !hiddenIds.includes(a.id));
	const [open, setOpen] = useState<number | null>(null);
	if (files.length === 0) return null;

	const total = files.reduce((n, a) => n + (a.sizeBytes ?? 0), 0);

	return (
		<div className="mt-5 border-t border-k-line pt-4">
			<div className="mb-3 flex items-center gap-2 text-[12.5px] text-k-ink-3">
				<Paperclip className="h-3.5 w-3.5" />
				<span>
					{files.length} attachment{files.length > 1 ? "s" : ""}
					{total > 0 && ` · ${formatBytes(total)}`}
				</span>
			</div>

			<div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(168px,1fr))]">
				{files.map((a, i) => {
					const kind = getKind(a);
					const name = a.filenameOriginal || "attachment";
					const canPreview = !!a.signedUrl && PREVIEWABLE.includes(kind);
					const badge = badgeFor(name, kind);
					return (
						<button
							key={a.id}
							type="button"
							title={canPreview ? `Preview ${name}` : `Open ${name}`}
							onClick={() => (canPreview ? setOpen(i) : a.signedUrl && window.open(a.signedUrl, "_blank", "noopener"))}
							className="k-focus group flex flex-col overflow-hidden rounded-k border border-k-line bg-k-surface text-left transition-[border-color,box-shadow] hover:border-k-line-strong hover:shadow-k-pane"
						>
							<div className="relative flex h-[92px] items-center justify-center overflow-hidden bg-k-surface-2">
								{kind === "image" && a.signedUrl ? (
									// biome-ignore lint/a11y/useAltText: decorative thumbnail, the name is shown below
									<img src={a.signedUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
								) : (
									<span
										className="rounded-[6px] px-2 py-1 text-[11px] font-bold tracking-wide text-white shadow-sm"
										style={{ background: badge.color }}
									>
										{badge.label}
									</span>
								)}
								{canPreview && (
									<span className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
										<span className="flex items-center gap-1.5 rounded-full bg-white/95 px-2.5 py-1 text-[12px] font-medium text-neutral-900">
											<Eye size={13} /> Preview
										</span>
									</span>
								)}
							</div>
							<div className="min-w-0 px-2.5 py-2">
								<div className="truncate text-[12.5px] font-medium text-k-ink">{name}</div>
								<div className="text-[11.5px] text-k-ink-3">
									{[badge.label, formatBytes(a.sizeBytes)].filter(Boolean).join(" · ")}
								</div>
							</div>
						</button>
					);
				})}
			</div>

			{open !== null && <Viewer files={files} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
		</div>
	);
}

export function Viewer({
	files,
	index,
	onIndex,
	onClose,
}: {
	files: MessageAttachmentWithUrl[];
	index: number;
	onIndex: (i: number) => void;
	onClose: () => void;
}) {
	// Only previewable files are cycled through.
	const previewable = files
		.map((a, i) => ({ a, i }))
		.filter(({ a }) => !!a.signedUrl && PREVIEWABLE.includes(getKind(a)));
	const pos = Math.max(0, previewable.findIndex((p) => p.i === index));
	const current = files[index];
	const kind = getKind(current);
	const name = current.filenameOriginal || "attachment";

	const go = useCallback(
		(step: number) => {
			if (previewable.length < 2) return;
			const next = previewable[(pos + step + previewable.length) % previewable.length];
			onIndex(next.i);
		},
		[previewable, pos, onIndex],
	);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			} else if (e.key === "ArrowRight") {
				e.preventDefault();
				e.stopPropagation();
				go(1);
			} else if (e.key === "ArrowLeft") {
				e.preventDefault();
				e.stopPropagation();
				go(-1);
			}
		};
		// Capture phase: runs before the mailbox's global shortcuts.
		window.addEventListener("keydown", onKey, true);
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			window.removeEventListener("keydown", onKey, true);
			document.body.style.overflow = prev;
		};
	}, [go, onClose]);

	const btn =
		"flex h-9 w-9 items-center justify-center rounded-full text-white/85 transition-colors hover:bg-white/15 hover:text-white";

	return createPortal(
		<div
			role="dialog"
			aria-modal="true"
			aria-label={`Preview ${name}`}
			className="fixed inset-0 z-[3000] flex flex-col bg-[rgb(12_12_14/0.92)] backdrop-blur-sm"
			onClick={onClose}
		>
			{/* Top bar */}
			<div className="flex h-14 shrink-0 items-center gap-3 px-4 text-white" onClick={(e) => e.stopPropagation()}>
				<div className="min-w-0 flex-1">
					<div className="truncate text-[14px] font-medium">{name}</div>
					<div className="text-[12px] text-white/55">
						{[formatBytes(current.sizeBytes), previewable.length > 1 ? `${pos + 1} of ${previewable.length}` : null]
							.filter(Boolean)
							.join(" · ")}
					</div>
				</div>
				<a
					href={current.signedUrl}
					target="_blank"
					rel="noreferrer noopener"
					className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-white/85 transition-colors hover:bg-white/15 hover:text-white"
				>
					<ExternalLink size={15} /> Open in a tab
				</a>
				{current.downloadUrl && (
					<a
						href={current.downloadUrl}
						download={name}
						className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-white/85 transition-colors hover:bg-white/15 hover:text-white"
					>
						<Download size={15} /> Download
					</a>
				)}
				<button type="button" onClick={onClose} className={btn} aria-label="Close (Esc)" title="Close (Esc)">
					<X size={18} />
				</button>
			</div>

			{/* Preview */}
			<div className="relative flex min-h-0 flex-1 items-center justify-center px-16 pb-6">
				{previewable.length > 1 && (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							go(-1);
						}}
						className={`${btn} absolute left-4 h-11 w-11 bg-white/10`}
						aria-label="Previous (←)"
						title="Previous (←)"
					>
						<ChevronLeft size={22} />
					</button>
				)}

				<div className="flex h-full w-full items-center justify-center" onClick={(e) => e.stopPropagation()}>
					{kind === "image" && (
						// biome-ignore lint/a11y/useAltText: the file name is in the top bar
						<img
							key={current.id}
							src={current.signedUrl}
							alt=""
							// small images (screenshots, logos) are enlarged to stay readable
							className="max-h-full max-w-full rounded-k object-contain shadow-2xl [image-rendering:auto]"
							style={{ minWidth: "min(420px, 100%)" }}
						/>
					)}
					{(kind === "pdf" || kind === "text") && (
						<iframe
							key={current.id}
							src={current.signedUrl}
							title={name}
							className="h-full w-full max-w-[1000px] rounded-k bg-white shadow-2xl"
						/>
					)}
					{kind === "video" && (
						// biome-ignore lint/a11y/useMediaCaption: received attachment, no known captions
						<video key={current.id} src={current.signedUrl} controls autoPlay className="max-h-full max-w-full rounded-k shadow-2xl" />
					)}
					{kind === "audio" && (
						<div className="w-full max-w-md rounded-k-pane bg-white/10 p-6 text-center text-white">
							<div className="mb-4 truncate text-[14px]">{name}</div>
							{/* biome-ignore lint/a11y/useMediaCaption: received attachment */}
							<audio key={current.id} src={current.signedUrl} controls autoPlay className="w-full" />
						</div>
					)}
				</div>

				{previewable.length > 1 && (
					<button
						type="button"
						onClick={(e) => {
							e.stopPropagation();
							go(1);
						}}
						className={`${btn} absolute right-4 h-11 w-11 bg-white/10`}
						aria-label="Next (→)"
						title="Next (→)"
					>
						<ChevronRight size={22} />
					</button>
				)}
			</div>
		</div>,
		document.body,
	);
}
