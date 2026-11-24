"use client";

// ss2i : pieces jointes sous un message lu.
// - Les images inline (Content-ID, deja integrees au corps HTML par mailparser) ne sont
//   plus repetees sous le mail : elles sont a leur place dans le texte.
// - Les vraies pieces jointes s'affichent en liste compacte (icone, nom, taille) ;
//   les apercus (vignettes d'images, PDF) ne se deplient qu'a la demande.

import { useState } from "react";
import { PublicConfig } from "@schema";
import { ChevronDown, ChevronUp, Download, Paperclip } from "lucide-react";
import EditorAttachmentItem, {
	formatBytes,
	getKind,
	KindIcon,
} from "@/components/mailbox/default/editor/editor-attachment-item";
import type { MessageAttachmentWithUrl } from "@/components/mailbox/default/email-renderer";
import { useK, useNouvelle } from "@/components/k/ui-context";
import { badgeFor, isPreviewable, Viewer } from "@/components/k/attachments";

// Variante « thread » : bloc du haut de la conversation, au-dela on replie.
const THREAD_VISIBLE = 8;

export default function MessageAttachments({
	attachments,
	publicConfig,
	hiddenIds,
	variant = "message",
}: {
	attachments: MessageAttachmentWithUrl[];
	publicConfig: PublicConfig;
	// Images inline deja affichees dans le corps du message.
	hiddenIds: string[];
	variant?: "message" | "thread";
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	const [showPreviews, setShowPreviews] = useState(false);
	// ss2i : un pptx s'ouvre dans la visionneuse, le navigateur ne sait pas l'afficher.
	const [viewerIndex, setViewerIndex] = useState<number | null>(null);
	const [showAll, setShowAll] = useState(false);

	const files = (attachments ?? []).filter((a) => !hiddenIds.includes(a.id));
	if (files.length === 0) return null;

	const inThread = variant === "thread";
	const visibleFiles = inThread && !showAll ? files.slice(0, THREAD_VISIBLE) : files;
	// En haut du fil, tout ce qui se previsualise s'ouvre dans la visionneuse.
	const opensInViewer = (a: MessageAttachmentWithUrl) => (inThread ? isPreviewable(a) : !!(a.contentUrl || a.textUrl || a.sheetUrl || a.zipUrl || a.emlUrl || a.wordUrl));

	const previewable = !inThread && files.some((a) => {
		const k = getKind(a);
		return !!a.signedUrl && (k === "image" || k === "pdf" || k === "video");
	});

	const frame = inThread
		? nouvelle
			? "rounded-k border border-k-line bg-k-surface px-3 py-2.5"
			: "rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
		: nouvelle
			? "border-t border-k-line py-3"
			: "border-t border-dotted py-3";

	return (
		<div className={frame}>
			<div className={`mb-2 flex items-center gap-3 text-sm ${nouvelle ? "text-k-ink" : ""}`}>
				<span className="inline-flex items-center gap-1.5 font-semibold">
					<Paperclip className="h-4 w-4" />
					{files.length} {files.length > 1 ? k("attachments", "pièces jointes") : k("attachment", "pièce jointe")}
					{inThread && ` ${k("in this thread", "dans ce fil")}`}
				</span>
				{previewable && (
					<button
						type="button"
						onClick={() => setShowPreviews((v) => !v)}
						className={
							nouvelle
								? "k-focus inline-flex items-center gap-1 rounded-k-sm px-2 py-0.5 text-xs text-k-ink-3 transition-colors hover:bg-k-hover hover:text-k-ink"
								: "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
						}
					>
						{showPreviews ? (
							<>
								<ChevronUp className="h-3.5 w-3.5" /> {k("Hide previews", "Masquer les aperçus")}
							</>
						) : (
							<>
								<ChevronDown className="h-3.5 w-3.5" /> {k("Show previews", "Afficher les aperçus")}
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
							onPreview={a.contentUrl || a.textUrl || a.sheetUrl || a.zipUrl || a.emlUrl || a.wordUrl ? () => setViewerIndex(i) : undefined}
						/>
					))}
				</div>
			) : (
				<div className="flex flex-wrap gap-2">
					{visibleFiles.map((a, i) => {
						const kind = getKind(a);
						const inViewer = opensInViewer(a);
						const name = a.filenameOriginal || k("attachment", "pièce jointe");
						const size = formatBytes(a.sizeBytes);
						return (
							// ss2i : le nom ouvre la piece jointe dans un onglet, la fleche la
							// telecharge (URL signee en Content-Disposition attachment).
							<div
								key={a.id}
								className={
									nouvelle
										? "group inline-flex max-w-xs items-center rounded-k-sm border border-k-line bg-k-surface text-[13px] text-k-ink transition-colors hover:border-k-line-strong hover:bg-k-hover"
										: "group inline-flex max-w-xs items-center rounded-lg border border-neutral-200 bg-white text-sm hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:bg-neutral-900"
								}
							>
								<a
									href={a.signedUrl || "#"}
									target="_blank"
									rel="noreferrer noopener"
									title={inViewer ? k(`Preview ${name}`, `Aperçu de ${name}`) : k(`Open ${name}`, `Ouvrir ${name}`)}
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
										// Meme repere que les vignettes des mails : image reelle ou pastille de type.
										kind === "image" && a.signedUrl ? (
											// biome-ignore lint/a11y/useAltText: vignette decorative, le nom est affiche a cote
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
									title={k(`Download ${name}`, `Télécharger ${name}`)}
									aria-label={k(`Download ${name}`, `Télécharger ${name}`)}
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
								nouvelle
									? "k-focus rounded-k-sm px-2 py-1.5 text-[13px] text-k-ink-3 hover:bg-k-hover hover:text-k-ink"
									: "rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
							}
						>
							{k(`Show ${files.length - visibleFiles.length} more`, `Afficher les ${files.length - visibleFiles.length} autres`)}
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
