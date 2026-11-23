"use client";
// Preview of a received .pptx, rendered in the browser. The file goes to no third-party
// service. The engine is only loaded when a preview opens; the external media referenced
// by the file are blocked (no tracking pixel).
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
				console.warn("[mail] pptx preview failed", error);
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
				{/* Content managed by the rendering engine, never by React. */}
				<div ref={hostRef} aria-label={name} className="w-full" />
			</div>
			{state === "loading" && (
				<div className="absolute inset-0 flex items-center justify-center gap-2 text-[14px] text-white/80">
					<Loader2 size={18} className="animate-spin" /> Preparing the preview…
				</div>
			)}
			{state === "error" && (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-[14px] text-white/85">
					<span>The preview of this presentation could not be displayed.</span>
					{downloadUrl && (
						<a
							href={downloadUrl}
							download={name}
							className="flex h-9 items-center gap-1.5 rounded-full bg-white/15 px-3 text-[13px] text-white hover:bg-white/25"
						>
							<Download size={15} /> Download the file
						</a>
					)}
				</div>
			)}
		</div>
	);
}
