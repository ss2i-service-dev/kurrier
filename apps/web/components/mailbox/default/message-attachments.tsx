"use client";

// Attachments below a displayed message.
// - Inline images (Content-ID, already embedded in the HTML body by mailparser) are
//   not repeated below the mail: they stay in place in the text.
// - Real attachments are shown as a compact list (icon, name, size); previews
//   (image thumbnails, PDF) only expand on demand.

import { useState } from "react";
import { PublicConfig } from "@schema";
import { ChevronDown, ChevronUp, Download, Paperclip } from "lucide-react";
import EditorAttachmentItem, {
	formatBytes,
	getKind,
	KindIcon,
} from "@/components/mailbox/default/editor/editor-attachment-item";
import type { MessageAttachmentWithUrl } from "@/components/mailbox/default/email-renderer";
import { useModernUi } from "@/components/k/ui-context";
import { badgeFor, isPreviewable, Viewer } from "@/components/k/attachments";

// "thread" variant: block at the top of the conversation, folded beyond this many files.
const THREAD_VISIBLE = 8;

export default function MessageAttachments({
	attachments,
	publicConfig,
	hiddenIds,
	variant = "message",
}: {
	attachments: MessageAttachmentWithUrl[];
	publicConfig: PublicConfig;
	// Inline images already displayed in the message body.
	hiddenIds: string[];
	variant?: "message" | "thread";
}) {
	const modern = useModernUi();
	const [showPreviews, setShowPreviews] = useState(false);
	// A .pptx opens in the viewer, the browser cannot display it.
	const [viewerIndex, setViewerIndex] = useState<number | null>(null);
	const [showAll, setShowAll] = useState(false);

	const files = (attachments ?? []).filter((a) => !hiddenIds.includes(a.id));
	if (files.length === 0) return null;

	const inThread = variant === "thread";
	const visibleFiles = inThread && !showAll ? files.slice(0, THREAD_VISIBLE) : files;
	// At the top of the thread, everything previewable opens in the viewer.
	const opensInViewer = (a: MessageAttachmentWithUrl) => (inThread ? isPreviewable(a) : !!(a.contentUrl || a.textUrl || a.sheetUrl || a.zipUrl));

	const previewable =
		!inThread &&
		files.some((a) => {
			const k = getKind(a);
			return !!a.signedUrl && (k === "image" || k === "pdf" || k === "video");
		});

	const frame = inThread
		? modern
			? "rounded-k border border-k-line bg-k-surface px-3 py-2.5"
			: "rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
		: modern
			? "border-t border-k-line py-3"
			: "border-t border-dotted py-3";

	return (
		<div className={frame}>
			<div className={`mb-2 flex items-center gap-3 text-sm ${modern ? "text-k-ink" : ""}`}>
				<span className="inline-flex items-center gap-1.5 font-semibold">
					<Paperclip className="h-4 w-4" />
					{files.length} {files.length > 1 ? "attachments" : "attachment"}
					{inThread && " in this thread"}
				</span>
				{previewable && (
					<button
						type="button"
						onClick={() => setShowPreviews((v) => !v)}
						className={
							modern
								? "k-focus inline-flex items-center gap-1 rounded-k-sm px-2 py-0.5 text-xs text-k-ink-3 transition-colors hover:bg-k-hover hover:text-k-ink"
								: "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
						}
					>
						{showPreviews ? (
							<>
								<ChevronUp className="h-3.5 w-3.5" /> {"Hide previews"}
							</>
						) : (
							<>
								<ChevronDown className="h-3.5 w-3.5" /> {"Show previews"}
							</>
						)}
					</button>
				)}
			</div>

			{showPreviews ? (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
					{files.map((a, i) => (
						<EditorAttachmentItem
							key={a.id}
							attachment={a}
							publicConfig={publicConfig}
							onPreview={a.contentUrl || a.textUrl || a.sheetUrl || a.zipUrl ? () => setViewerIndex(i) : undefined}
						/>
					))}
				</div>
			) : (
				<div className="flex flex-wrap gap-2">
					{visibleFiles.map((a, i) => {
						const kind = getKind(a);
						const inViewer = opensInViewer(a);
						const name = a.filenameOriginal || "attachment";
						const size = formatBytes(a.sizeBytes);
						return (
							// The name opens the attachment in a tab, the arrow downloads it
							// (signed URL with Content-Disposition attachment).
							<div
								key={a.id}
								className={
									modern
										? "group inline-flex max-w-xs items-center rounded-k-sm border border-k-line bg-k-surface text-[13px] text-k-ink transition-colors hover:border-k-line-strong hover:bg-k-hover"
										: "group inline-flex max-w-xs items-center rounded-lg border border-neutral-200 bg-white text-sm hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:bg-neutral-900"
								}
							>
								<a
									href={a.signedUrl || "#"}
									target="_blank"
									rel="noreferrer noopener"
									title={inViewer ? `Preview ${name}` : `Open ${name}`}
									onClick={
										inViewer
											? (e) => {
													e.preventDefault();
													setViewerIndex(i);
												}
											: undefined
									}
									className="inline-flex min-w-0 items-center gap-2 py-1.5 pl-2.5 pr-1"
								>
									{inThread ? (
										// Same marker as the mail thumbnails: real image or type badge.
										kind === "image" && a.signedUrl ? (
											// biome-ignore lint/a11y/useAltText: decorative thumbnail, the name is shown beside it
											<img src={a.signedUrl} alt="" loading="lazy" className="h-5 w-5 shrink-0 rounded-[4px] object-cover" />
										) : (
											<span
												className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] font-bold leading-none tracking-wide text-white"
												style={{ background: badgeFor(name, kind).color }}
											>
												{badgeFor(name, kind).label}
											</span>
										)
									) : (
										<span className="shrink-0 text-neutral-500">
											<KindIcon kind={kind} />
										</span>
									)}
									<span className="min-w-0 truncate hover:underline">{name}</span>
									{size && (
										<span className="shrink-0 text-xs text-muted-foreground">{size}</span>
									)}
								</a>
								<a
									href={a.downloadUrl || a.signedUrl || "#"}
									download={name}
									title={`Download ${name}`}
									aria-label={`Download ${name}`}
									className="mr-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
								>
									<Download className="h-3.5 w-3.5" />
								</a>
							</div>
						);
					})}
					{visibleFiles.length < files.length && (
						<button
							type="button"
							onClick={() => setShowAll(true)}
							className={
								modern
									? "k-focus rounded-k-sm px-2 py-1.5 text-[13px] text-k-ink-3 hover:bg-k-hover hover:text-k-ink"
									: "rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
							}
						>
							Show {files.length - visibleFiles.length} more
						</button>
					)}
				</div>
			)}

			{viewerIndex !== null && files[viewerIndex] && (
				<Viewer files={files} index={viewerIndex} onIndex={setViewerIndex} onClose={() => setViewerIndex(null)} />
			)}
		</div>
	);
}
