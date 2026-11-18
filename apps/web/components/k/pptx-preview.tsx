"use client";
// ss2i : apercu d'un pptx recu, rendu dans le navigateur (Hugo le 18/11/2026). Le fichier ne
// part chez aucun service tiers. Le moteur n'est charge qu'a l'ouverture d'un apercu ; les
// medias externes references par le fichier sont bloques (pas de pixel de suivi).
import React, { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";

export default function PptxPreview({
	url,
	name,
	downloadUrl,
}: {
	url: string;
	name: string;
	downloadUrl?: string;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const hostRef = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");

	useEffect(() => {
		const host = hostRef.current;
		const scrollContainer = scrollRef.current;
		if (!host || !scrollContainer) return;
		const controller = new AbortController();
		const { signal } = controller;
		let viewer: { destroy(): void } | null = null;
		setState("loading");

		(async () => {
			try {
				const response = await fetch(url, { signal, credentials: "same-origin" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = await response.arrayBuffer();
				const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
				if (signal.aborted) return;
				const opened = await PptxViewer.open(data, host, {
					signal,
					renderMode: "list",
					fitMode: "contain",
					scrollContainer,
					listOptions: { windowed: true, initialSlides: 4, batchSize: 4 },
					zipLimits: RECOMMENDED_ZIP_LIMITS,
					externalMedia: "block",
					pdfjs: false,
				});
				if (signal.aborted) {
					opened.destroy();
					return;
				}
				viewer = opened;
				setState("ready");
			} catch (error) {
				if (signal.aborted) return;
				console.warn("[courrier] apercu pptx impossible", error);
				setState("error");
			}
		})();

		return () => {
			controller.abort();
			viewer?.destroy();
			host.replaceChildren();
		};
	}, [url]);

	return (
		<div className="relative h-full w-full">
			<div ref={scrollRef} className="h-full w-full overflow-y-auto rounded-k bg-neutral-800 shadow-2xl">
				{/* Contenu gere par le moteur de rendu, jamais par React. */}
				<div ref={hostRef} aria-label={name} className="w-full" />
			</div>
			{state === "loading" && (
				<div className="absolute inset-0 flex items-center justify-center gap-2 text-[14px] text-white/80">
					<Loader2 size={18} className="animate-spin" /> Préparation de l'aperçu…
				</div>
			)}
			{state === "error" && (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[14px] text-white/85">
					<span>L'aperçu de cette présentation n'a pas pu être affiché.</span>
					{downloadUrl && (
						<a
							href={downloadUrl}
							download={name}
							className="flex h-9 items-center gap-1.5 rounded-full bg-white/15 px-3 text-[13px] text-white hover:bg-white/25"
						>
							<Download size={15} /> Télécharger le fichier
						</a>
					)}
				</div>
			)}
		</div>
	);
}
