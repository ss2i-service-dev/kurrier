"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, ToasterProps } from "sonner";
import { burstParticles, toastCloseButtonForClick, TOAST_POP_MS } from "@/lib/toast-click-dismiss";

// Gerbe de bulles au point du clic, retiree a la fin de son animation.
function burst(x: number, y: number) {
	for (const p of burstParticles()) {
		const dot = document.createElement("span");
		Object.assign(dot.style, {
			position: "fixed",
			left: `${x - p.size / 2}px`,
			top: `${y - p.size / 2}px`,
			width: `${p.size}px`,
			height: `${p.size}px`,
			borderRadius: "9999px",
			background: p.color,
			pointerEvents: "none",
			zIndex: "2147483647",
		});
		document.body.appendChild(dot);
		dot
			.animate(
				[
					{ transform: "translate(0, 0) scale(1)", opacity: 1 },
					{ transform: `translate(${p.dx}px, ${p.dy}px) scale(0.2)`, opacity: 0 },
				],
				{ duration: 520, delay: p.delay, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "forwards" },
			)
			.finished.finally(() => dot.remove());
	}
}

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	// Clic sur une notification hors de ses boutons : elle se ferme (Samuel le 10/11).
	useEffect(() => {
		const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const onClick = (e: MouseEvent) => {
			const target = e.target instanceof Element ? e.target : null;
			// La croix ferme deja par sonner : on ajoute seulement l'eclat.
			if (target?.closest("[data-sonner-toast] [data-close-button]")) {
				if (!calm()) burst(e.clientX, e.clientY);
				return;
			}
			const close = toastCloseButtonForClick(target);
			if (!(close instanceof HTMLElement)) return;
			const toastEl = close.closest("[data-sonner-toast]");
			if (calm() || !(toastEl instanceof HTMLElement) || toastEl.classList.contains("ss2i-toast-pop")) {
				close.click();
				return;
			}
			toastEl.classList.add("ss2i-toast-pop");
			burst(e.clientX, e.clientY);
			setTimeout(() => close.click(), TOAST_POP_MS);
		};
		document.addEventListener("click", onClick);
		return () => document.removeEventListener("click", onClick);
	}, []);

	return (
		<Sonner
			theme={theme as ToasterProps["theme"]}
			className="toaster group"
			closeButton
			toastOptions={{ className: "cursor-pointer" }}
			style={
				{
					"--normal-bg": "var(--popover)",
					"--normal-text": "var(--popover-foreground)",
					"--normal-border": "var(--border)",
				} as React.CSSProperties
			}
			{...props}
		/>
	);
};

export { Toaster };
