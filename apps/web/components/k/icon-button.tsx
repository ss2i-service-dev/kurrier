"use client";
// Icon button of the modern interface, with a tooltip and the shortcut shown.
import React from "react";
import { Tooltip } from "@mantine/core";

type Props = React.ButtonHTMLAttributes<HTMLButtonElement> & {
	label: string;
	shortcut?: string;
	tone?: "default" | "danger" | "accent";
	size?: "sm" | "md";
	/** Stable identifier read by /keyboard-shortcuts.js */
	action?: string;
};

export default function KIconButton({
	label,
	shortcut,
	tone = "default",
	size = "md",
	action,
	className = "",
	children,
	...rest
}: Props) {
	const tones = {
		default: "text-k-ink-2 hover:text-k-ink hover:bg-k-hover",
		danger: "text-k-ink-2 hover:text-k-danger hover:bg-k-danger-soft",
		accent: "text-k-accent hover:bg-k-accent-soft",
	};
	const dims = size === "sm" ? "h-7 w-7 [&_svg]:size-[15px]" : "h-8 w-8 [&_svg]:size-[17px]";
	return (
		<Tooltip
			label={
				<span className="flex items-center gap-2">
					{label}
					{shortcut && (
						<kbd className="rounded bg-white/15 px-1.5 font-mono text-[10px] leading-4">{shortcut}</kbd>
					)}
				</span>
			}
			openDelay={350}
			withArrow
			fz="xs"
		>
			<button
				type="button"
				aria-label={label}
				data-k-action={action}
				className={`k-focus inline-flex items-center justify-center rounded-k-sm transition-colors disabled:opacity-40 ${dims} ${tones[tone]} ${className}`}
				{...rest}
			>
				{children}
			</button>
		</Tooltip>
	);
}
