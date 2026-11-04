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

export default function MessageAttachments({
	attachments,
	publicConfig,
	hiddenIds,
}: {
	attachments: MessageAttachmentWithUrl[];
	publicConfig: PublicConfig;
	// Images inline deja affichees dans le corps du message.
	hiddenIds: string[];
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	const [showPreviews, setShowPreviews] = useState(false);

	const files = (attachments ?? []).filter((a) => !hiddenIds.includes(a.id));
	if (files.length === 0) return null;

	const previewable = files.some((a) => {
		const k = getKind(a);
		return !!a.signedUrl && (k === "image" || k === "pdf" || k === "video");
	});

	return (
		<div className={nouvelle ? "border-t border-k-line py-3" : "border-t border-dotted py-3"}>
			<div className={`mb-2 flex items-center gap-3 text-sm ${nouvelle ? "text-k-ink" : ""}`}>
				<span className="inline-flex items-center gap-1.5 font-semibold">
					<Paperclip className="h-4 w-4" />
					{files.length} {files.length > 1 ? k("attachments", "pièces jointes") : k("attachment", "pièce jointe")}
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
					{files.map((a) => (
						<EditorAttachmentItem key={a.id} attachment={a} publicConfig={publicConfig} />
					))}
				</div>
			) : (
				<div className="flex flex-wrap gap-2">
					{files.map((a) => {
						const kind = getKind(a);
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
									title={k(`Open ${name}`, `Ouvrir ${name}`)}
									className="inline-flex min-w-0 items-center gap-2 py-1.5 pl-2.5 pr-1"
								>
									<span className="shrink-0 text-neutral-500">
										<KindIcon kind={kind} />
									</span>
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
				</div>
			)}
		</div>
	);
}
