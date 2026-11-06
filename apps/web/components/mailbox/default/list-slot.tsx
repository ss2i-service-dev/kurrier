"use client";
import React from "react";
import { usePathname } from "next/navigation";
import { listIsHidden, type ListUnderThread } from "@/lib/list-under-thread";

// ss2i : en navigation douce, la page du dossier (la liste) reste affichee sous
// le fil ouvert dans le slot @thread, et le fil, souvent le plus recent,
// apparaissait deux fois. Avec l'option « masquee » (defaut), la liste n'est
// pas rendue tant que l'URL porte un fil ; elle revient des que l'URL n'en a
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
	if (listIsHidden(mode, pathname)) return null;
	return <>{children}</>;
}
