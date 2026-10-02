"use client";
import React from "react";
import { useParams } from "next/navigation";

// Le fil ouvert est rendu dans la route parallele « @thread ». En navigation
// douce (clic sur Inbox dans la barre laterale), Next conserve le contenu de
// cette route tant qu'un autre segment ne la remplace pas : le message restait
// affiche au-dessus de la liste. On ne rend le fil que si l'URL en porte un.
export default function ThreadSlot({ children }: { children: React.ReactNode }) {
	const params = useParams() as { threadId?: string };
	if (!params?.threadId) return null;
	return <>{children}</>;
}
