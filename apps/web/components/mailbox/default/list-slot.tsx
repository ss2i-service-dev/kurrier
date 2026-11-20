"use client";
import React from "react";
import { usePathname } from "next/navigation";
import { listIsHidden, type ListUnderThread } from "@/lib/list-under-thread";
import { useMarkListMounted } from "@/components/mailbox/default/list-under-thread-context";

// ss2i : en navigation douce, la page du dossier (la liste) reste affichee sous
// le fil ouvert dans le slot @thread, et le fil, souvent le plus recent,
// apparaissait deux fois. Avec l'option « masquee » (defaut), la liste n'est
// pas visible tant que l'URL porte un fil ; elle revient des que l'URL n'en a
// plus (retour, clic sur le dossier, fermeture du fil).
//
// Meme test de chemin que ThreadSlot (usePathname, pas useParams : dans un slot
// conserve, useParams rend encore l'ancien threadId).
export default function ListSlot({
	mode,
	children,
}: {
	mode: ListUnderThread;
	children: React.ReactNode;
}) {
	const pathname = usePathname();
	useMarkListMounted();
	// ss2i (20/11) : la liste n'est plus demontee (remontee en streaming, sa position
	// revenait trop tot ou pas du tout) : elle reste montee, invisible et inert, sous le
	// panneau du fil (thread-pane.tsx). Sa hauteur et le scrollY du document ne bougent pas.
	const hidden = listIsHidden(mode, pathname);
	return (
		<div className={hidden ? "contents invisible" : "contents"} inert={hidden} data-ss2i-list-slot="">
			{children}
		</div>
	);
}
