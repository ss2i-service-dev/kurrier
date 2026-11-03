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
	const [showPreviews, setShowPreviews] = useState(false);

	const files = (attachments ?? []).filter((a) => !hiddenIds.includes(a.id));
	if (files.length === 0) return null;

	const previewable = files.some((a) => {
		const k = getKind(a);
		return !!a.signedUrl && (k === "image" || k === "pdf" || k === "video");
	});

	return (
		<div className="border-t border-dotted py-3">
			<div className="mb-2 flex items-center gap-3 text-sm">
				<span className="inline-flex items-center gap-1.5 font-semibold">
					<Paperclip className="h-4 w-4" />
					{files.length} {files.length > 1 ? "attachments" : "attachment"}
				</span>
				{previewable && (
					<button
						type="button"
						onClick={() => setShowPreviews((v) => !v)}
						className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						{showPreviews ? (
							<>
								<ChevronUp className="h-3.5 w-3.5" /> Hide previews
							</>
						) : (
							<>
								<ChevronDown className="h-3.5 w-3.5" /> Show previews
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
						const name = a.filenameOriginal || "attachment";
						const size = formatBytes(a.sizeBytes);
						return (
							<a
								key={a.id}
								href={a.signedUrl || "#"}
								target="_blank"
								rel="noreferrer noopener"
								title={name}
								className="group inline-flex max-w-xs items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm hover:border-neutral-300 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:bg-neutral-900"
							>
								<span className="shrink-0 text-neutral-500">
									<KindIcon kind={kind} />
								</span>
								<span className="min-w-0 truncate group-hover:underline">{name}</span>
								{size && (
									<span className="shrink-0 text-xs text-muted-foreground">{size}</span>
								)}
								<Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
							</a>
						);
					})}
				</div>
			)}
		</div>
	);
}
