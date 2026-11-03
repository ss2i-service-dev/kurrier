// SS2i (nouvelle interface) : cadre des ecrans pleine largeur hors dossier
// (reportes, envois programmes, clients) : panneau, barre de recherche, zone defilante.
import React from "react";
import KPane from "@/components/k/pane";
import KSearchHeader from "@/components/k/search-header";

export default async function KSectionLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<Record<string, string>>;
}) {
	// La recherche de ces ecrans porte sur la boite de reception de l'identite.
	const withSlug = params.then((p) => ({ ...p, mailboxSlug: "inbox" }));
	return (
		<KPane scroll={false}>
			<KSearchHeader params={withSlug} />
			<div className="k-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
		</KPane>
	);
}
