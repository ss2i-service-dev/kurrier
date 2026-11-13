"use client";
import React from "react";
import { usePathname, useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { leaveThreadToList } from "@/lib/leave-thread";
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
	const router = useRouter();
	if (!/\/threads\/[^/]+/.test(pathname ?? "")) return null;
	// ss2i : sur mobile, aucun moyen de revenir a la liste depuis un fil hormis le bouton
	// Precedent du telephone : barre de retour collee sous la barre du haut.
	const back = (
		<div className="sticky top-[var(--ss2i-mail-header-h,0px)] z-40 border-b bg-background/95 px-2 py-1 backdrop-blur md:hidden" data-ss2i-thread-back="">
			<button
				type="button"
				onClick={() => leaveThreadToList(router, pathname ?? "")}
				className="inline-flex h-9 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted"
			>
				<ArrowLeft className="h-4 w-4" />
				Back
			</button>
		</div>
	);
	if (!unreadPanel) return <>{back}{children}</>;
	return (
		<>
		{back}
		<div className="flex items-start">
			<div className="min-w-0 flex-1" data-ss2i-thread-column="">
				{children}
			</div>
			<UnreadPanel identityPublicId={unreadPanel.identityPublicId} mailboxSlug={unreadPanel.mailboxSlug} />
		</div>
		</>
	);
}
