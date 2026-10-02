"use client";
import React from "react";
import { usePathname } from "next/navigation";

// Le fil ouvert est rendu dans la route parallele « @thread ». En navigation
// douce (clic sur Inbox dans la barre laterale), Next conserve le contenu de
// cette route tant qu'un autre segment ne la remplace pas : le message restait
// affiche au-dessus de la liste. On ne rend le fil que si l'URL en porte un.
//
// Se fier au CHEMIN, pas a useParams : dans le slot conserve, useParams rend
// encore l'ancien threadId alors que l'URL a change.
export default function ThreadSlot({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();
	if (!/\/threads\/[^/]+/.test(pathname ?? "")) return null;
	return <>{children}</>;
}
