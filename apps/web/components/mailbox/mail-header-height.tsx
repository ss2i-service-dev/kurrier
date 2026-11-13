"use client";
import { useLayoutEffect, useRef } from "react";

// ss2i : la barre du haut de l'interface classique (recherche, identite) est collante et sa
// hauteur varie (74 px sur ordinateur, davantage sur un ecran etroit). Les barres collees
// sous elle (actions de la liste, retour d'un fil sur mobile) lisent sa hauteur dans
// --ss2i-mail-header-h, tenue a jour ici. Sans ce decalage, elles se collaient en top-0,
// donc sous la barre du haut, et leurs commandes disparaissaient des le premier defilement.
export const MAIL_HEADER_VAR = "--ss2i-mail-header-h";

export default function MailHeaderHeight() {
	const ref = useRef<HTMLSpanElement>(null);
	useLayoutEffect(() => {
		const header = ref.current?.parentElement;
		if (!header) return;
		const root = document.documentElement;
		const apply = () => root.style.setProperty(MAIL_HEADER_VAR, `${header.getBoundingClientRect().height}px`);
		apply();
		const ro = new ResizeObserver(apply);
		ro.observe(header);
		return () => {
			ro.disconnect();
			root.style.removeProperty(MAIL_HEADER_VAR);
		};
	}, []);
	return <span ref={ref} hidden={true} />;
}
