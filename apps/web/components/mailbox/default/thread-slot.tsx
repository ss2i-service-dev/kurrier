"use client";
import React from "react";
import { usePathname } from "next/navigation";
import UnreadPanel from "@/components/mailbox/default/unread-panel";

// Le fil ouvert est rendu dans la route parallele « @thread ». En navigation
// douce (clic sur Inbox dans la barre laterale), Next conserve le contenu de
// cette route tant qu'un autre segment ne la remplace pas : le message restait
// affiche au-dessus de la liste. On ne rend le fil que si l'URL en porte un.
//
// Se fier au CHEMIN, pas a useParams : dans le slot conserve, useParams rend
// encore l'ancien threadId alors que l'URL a change.
//
// ss2i : avec l'option « Unread messages panel » (unreadPanel renseigne), le
// fil est place dans une colonne souple et le panneau des non-lus a sa droite ;
// sans l'option, rien ne change.
export default function ThreadSlot({
	children,
	unreadPanel,
}: {
	children: React.ReactNode;
	unreadPanel?: { identityPublicId: string; mailboxSlug: string } | null;
}) {
	const pathname = usePathname();
	if (!/\/threads\/[^/]+/.test(pathname ?? "")) return null;
	if (!unreadPanel) return <>{children}</>;
	return (
		<div className="flex items-start">
			<div className="min-w-0 flex-1" data-ss2i-thread-column="">
				{children}
			</div>
			<UnreadPanel identityPublicId={unreadPanel.identityPublicId} mailboxSlug={unreadPanel.mailboxSlug} />
		</div>
	);
}
