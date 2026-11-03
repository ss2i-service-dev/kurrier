"use client";
// SS2i : ecrans de chargement des routes de la messagerie. Le choix d'interface
// est deja connu cote client (contexte pose par le layout racine) : aucune
// requete serveur pour choisir entre le squelette Outlook et le chargement
// d'origine (avant : une lecture en base a chaque navigation).
import Loading from "@/app/loading";
import { useNouvelle } from "@/components/k/ui-context";
import { ListSkeleton, ReaderSkeleton } from "@/components/k/skeletons";

export function ListLoading() {
	return useNouvelle() ? <ListSkeleton /> : <Loading />;
}

export function ReaderLoading() {
	return useNouvelle() ? <ReaderSkeleton /> : <Loading />;
}

/** Route sans contenu en Gmail (@thread/threads/[threadId]). */
export function ReaderLoadingOutlookOnly() {
	return useNouvelle() ? <ReaderSkeleton /> : null;
}
