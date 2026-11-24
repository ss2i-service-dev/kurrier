"use client";
// ss2i : apercu d'un document Word (.docx) recu, rendu dans le navigateur par docx-preview
// (Hugo le 24/11/2026, voir lib/word-preview.ts). Le moteur n'est charge qu'a l'ouverture.
// Rendu dans une racine fantome (styles du document isoles de l'application) ; blocs HTML
// incrustes (altChunk, en iframe) non rendus ; apres rendu, liens limites au web et au mail,
// images limitees a celles du document, attributs on* et elements actifs retires.
import React, { useEffect, useRef, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { safeDocUrl } from "@/lib/word-preview";

const PAGE_CSS = `
:host { display: block; }
.ss2i-doc-wrapper { background: #e5e5e5; padding: 24px 12px; display: flex; flex-direction: column; align-items: center; gap: 16px; }
.ss2i-doc-wrapper > section.ss2i-doc { box-shadow: 0 4px 18px rgb(0 0 0 / 0.18); margin: 0 auto; max-width: 100%; }
a { color: #2563eb; }
`;

function sanitize(root: ParentNode) {
	root.querySelectorAll("script, iframe, object, embed, link, meta, base, form").forEach((el) => el.remove());
	root.querySelectorAll<HTMLElement>("*").forEach((el) => {
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (name.startsWith("on")) el.removeAttribute(attr.name);
			else if (name === "href" || name === "xlink:href") {
				const ok = safeDocUrl(attr.value, "href");
				if (ok === null) el.removeAttribute(attr.name);
			} else if (name === "src" || name === "srcset") {
				if (safeDocUrl(attr.value, "src") === null) el.removeAttribute(attr.name);
			} else if (name === "style" && /url\(\s*['"]?(?!blob:|data:image\/)/i.test(attr.value)) {
				el.style.removeProperty("background-image");
				el.style.removeProperty("background");
			}
		}
		if (el.tagName === "A" && el.getAttribute("href") && !el.getAttribute("href")!.startsWith("#")) {
			el.setAttribute("target", "_blank");
			el.setAttribute("rel", "nofollow noopener noreferrer");
		}
	});
}

export default function WordPreview({ url, name, downloadUrl }: { url: string; name: string; downloadUrl?: string }) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const controller = new AbortController();
		const { signal } = controller;
		const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
		shadow.replaceChildren();
		setState("loading");

		(async () => {
			try {
				const response = await fetch(url, { signal, credentials: "same-origin" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = await response.arrayBuffer();
				const { renderAsync } = await import("docx-preview");
				if (signal.aborted) return;
				const base = document.createElement("style");
				base.textContent = PAGE_CSS;
				const styles = document.createElement("div");
				const body = document.createElement("div");
				shadow.append(base, styles, body);
				await renderAsync(data, body, styles, {
					className: "ss2i-doc",
					inWrapper: true,
					ignoreLastRenderedPageBreak: true,
					renderAltChunks: false,
					renderComments: false,
					renderChanges: false,
					useBase64URL: false,
				});
				if (signal.aborted) return;
				sanitize(body);
				setState("ready");
			} catch (error) {
				if (signal.aborted) return;
				console.warn("[courrier] apercu docx impossible", error);
				shadow.replaceChildren();
				setState("error");
			}
		})();

		return () => {
			controller.abort();
			shadow.replaceChildren();
		};
	}, [url]);

	return (
		<div className="relative h-full w-full">
			<div className="h-full w-full overflow-auto rounded-k bg-neutral-200 shadow-2xl">
				{/* Contenu gere par docx-preview dans une racine fantome, jamais par React. */}
				<div ref={hostRef} aria-label={name} className="w-full" />
			</div>
			{state === "loading" && (
				<div className="absolute inset-0 flex items-center justify-center gap-2 rounded-k bg-neutral-800 text-[14px] text-white/80">
					<Loader2 size={18} className="animate-spin" /> Préparation de l'aperçu…
				</div>
			)}
			{state === "error" && (
				<div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-k bg-neutral-800 px-6 text-center text-[14px] text-white/85">
					<span>L'aperçu de ce document n'a pas pu être affiché.</span>
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
