import React from "react";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import { Users } from "lucide-react";
import { KEmptyState } from "@/components/k/section";

function ClassicPage() {
	return (
		<div className={"flex items-center justify-center my-24 text-sm"}>
			Please select a contact to view details.
		</div>
	);
}

// ss2i : nouvelle interface : fiche vide a droite de la liste.
export default async function Page() {
	if (!(await isNouvelleInterface())) return <ClassicPage />;
	return (
		<KEmptyState
			icon={<Users size={22} strokeWidth={1.6} />}
			title="Aucun contact sélectionné"
			text="Choisissez un contact dans la liste pour afficher sa fiche, ou créez-en un nouveau."
		/>
	);
}
