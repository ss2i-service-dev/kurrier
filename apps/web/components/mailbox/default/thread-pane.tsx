"use client";
// ss2i (Samuel le 20/11) : « je scrolle dans mon mail, je ferme le mail, oh bah la liste de mes
// mails elle a scrolle aussi ». Interface classique : la liste et le fil defilaient dans le meme
// document, et la position de la liste etait retablie apres coup (05/11, 19/11), trop tot quand
// la liste revenait en streaming. Ici le fil a son propre defilement : un panneau fixe sous la
// barre du haut, a la largeur de la colonne principale (la barre laterale reste visible), avec
// la liste montee dessous sans bouger (ListSlot et les listes la rendent invisible et inert).
// - document bloque (overflow hidden sur html) tant que le panneau est ouvert : la molette sur
//   la barre du haut ou laterale ne fait plus defiler la liste cachee ; le scrollY est conserve ;
// - overscroll-contain : arrive en bas du fil, le defilement ne passe pas au document ;
// - focus sur le panneau : Espace, PageDown, fleches defilent le fil ;
// - chaque fil commence en haut du panneau (fil suivant, lien du panneau des non-lus).
import React, { useLayoutEffect, useRef, useState } from "react";

export default function ThreadPane({ threadKey, children }: { threadKey: string; children: React.ReactNode }) {
	const anchor = useRef<HTMLDivElement>(null);
	const pane = useRef<HTMLDivElement>(null);
	const [box, setBox] = useState<{ left: number; width: number } | null>(null);

	// Position et largeur de la colonne principale, relevees sur un repere dans le flux.
	useLayoutEffect(() => {
		const el = anchor.current;
		if (!el) return;
		const measure = () => {
			const r = el.getBoundingClientRect();
			setBox((b) => (b && b.left === r.left && b.width === r.width ? b : { left: r.left, width: r.width }));
		};
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		window.addEventListener("resize", measure);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, []);

	useLayoutEffect(() => {
		const html = document.documentElement;
		const before = { overflow: html.style.overflow, gutter: html.style.scrollbarGutter };
		html.style.scrollbarGutter = "stable";
		html.style.overflow = "hidden";
		return () => {
			html.style.overflow = before.overflow;
			html.style.scrollbarGutter = before.gutter;
		};
	}, []);

	useLayoutEffect(() => {
		const el = pane.current;
		if (!el) return;
		el.scrollTop = 0;
		// Focus seulement s'il est perdu (body) ou reste sur la liste devenue inert : jamais pris
		// a un champ ou a une redaction en cours (insight #4882).
		const active = document.activeElement as HTMLElement | null;
		if (!active || active === document.body || active.closest("[inert]")) el.focus({ preventScroll: true });
	}, [threadKey]);

	return (
		<>
			<div ref={anchor} aria-hidden="true" className="h-0 w-full" />
			<div
				ref={pane}
				tabIndex={-1}
				data-ss2i-thread-pane=""
				style={box ? { left: box.left, width: box.width } : { left: 0, right: 0 }}
				className="fixed bottom-0 top-[var(--ss2i-mail-header-h,0px)] z-30 overflow-y-auto overscroll-contain bg-background outline-none"
			>
				{children}
			</div>
		</>
	);
}
