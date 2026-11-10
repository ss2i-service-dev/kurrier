"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, ToasterProps } from "sonner";
import { toastCloseButtonForClick } from "@/lib/toast-click-dismiss";

const Toaster = ({ ...props }: ToasterProps) => {
	const { theme = "system" } = useTheme();

	// A click on a notification outside its buttons closes it.
	useEffect(() => {
		const onClick = (e: MouseEvent) => {
			const close = toastCloseButtonForClick(e.target instanceof Element ? e.target : null);
			if (close instanceof HTMLElement) close.click();
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
