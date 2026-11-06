// Interface classique : la liste du dossier sous un fil ouvert. Logique pure
// (testee dans test/list-under-thread.ts), partagee par l'action serveur, le
// composant ListSlot et les reglages.

export type ListUnderThread = "hidden" | "shown";

// Masquee par defaut : toute valeur inconnue ou absente donne « hidden ».
export function parseListUnderThread(value: unknown): ListUnderThread {
	return value === "shown" ? "shown" : "hidden";
}

// Meme test de chemin que ThreadSlot : le chemin, pas useParams.
export function pathHasThread(pathname: string | null | undefined): boolean {
	return /\/threads\/[^/]+/.test(pathname ?? "");
}

export function listIsHidden(mode: ListUnderThread, pathname: string | null | undefined): boolean {
	return mode === "hidden" && pathHasThread(pathname);
}
