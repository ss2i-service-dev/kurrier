// Main "New contact" button of the sidebar (same style as "New message").
import React from "react";
import Link from "next/link";
import { UserPlus } from "lucide-react";

export default function KNewContactButton({ workspacePublicId }: { workspacePublicId: string }) {
	return (
		<Link
			href={`/w/${workspacePublicId}/dashboard/contacts/new`}
			className="k-focus group flex h-10 w-full items-center gap-2.5 rounded-k bg-k-accent px-3.5 text-[14px] font-medium text-k-accent-ink shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.12)] transition-colors hover:bg-k-accent-hover"
		>
			<UserPlus className="h-4 w-4" />
			<span className="flex-1 text-left">New contact</span>
		</Link>
	);
}
