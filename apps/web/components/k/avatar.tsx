// Initials avatar, with a stable colour derived from the address.
import React from "react";

const PALETTE = [
	["#e8eefc", "#2f4fb8"],
	["#fde9e1", "#b4431c"],
	["#e3f4ea", "#23774a"],
	["#f3e8fb", "#7a3bb0"],
	["#fff1d6", "#996000"],
	["#e1f3f6", "#1e6f80"],
	["#fbe4ec", "#ad2f5b"],
	["#ececea", "#4d4a45"],
];

function hash(s: string) {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return Math.abs(h);
}

export function initials(name?: string | null, email?: string | null) {
	const src = (name?.trim() || email?.split("@")[0] || "?").replace(/[^\p{L}\p{N} ]/gu, " ");
	const parts = src.split(/\s+/).filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}

export default function KAvatar({
	name,
	email,
	size = 32,
	className = "",
}: {
	name?: string | null;
	email?: string | null;
	size?: number;
	className?: string;
}) {
	const [bg, fg] = PALETTE[hash((email || name || "?").toLowerCase()) % PALETTE.length];
	return (
		<span
			aria-hidden
			className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ${className}`}
			style={{
				width: size,
				height: size,
				fontSize: Math.round(size * 0.38),
				background: `light-dark(${bg}, color-mix(in srgb, ${fg} 30%, #19191b))`,
				color: `light-dark(${fg}, color-mix(in srgb, ${bg} 85%, white))`,
				letterSpacing: "0.01em",
			}}
		>
			{initials(name, email)}
		</span>
	);
}
