"use client";
import { Menu } from "lucide-react";
import { useMailShell } from "@/components/k/mail-shell";

export default function MobileNavButton() {
	const { openNav } = useMailShell();
	return (
		<button
			type="button"
			onClick={openNav}
			aria-label="Open folders"
			className="flex h-9 w-9 shrink-0 items-center justify-center rounded-k text-k-ink-2 hover:bg-k-hover md:hidden"
		>
			<Menu size={18} />
		</button>
	);
}
