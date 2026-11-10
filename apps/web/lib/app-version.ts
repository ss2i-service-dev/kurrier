// Version de build visible et rechargement force apres un deploiement (regle appli-web-js).
// Sans cela, un onglet ouvert avant un deploiement garde l'ancien bundle et ses identifiants
// d'actions serveur : Next ne les trouve plus et affiche « An unexpected response was
// received from the server. » (Samuel le 10/11, bulle d'evenement de l'agenda).

// Numero de build : date et heure de Paris, puis le dernier patch applique (image mail-souverain).
export function formatBuildVersion(date: Date, patchLevel?: string): string {
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat("en-GB", {
			timeZone: "Europe/Paris",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(date)
			.map((p) => [p.type, p.value]),
	);
	const base = `${parts.year}${parts.month}${parts.day}.${parts.hour}${parts.minute}`;
	return patchLevel ? `${base}-p${patchLevel}` : base;
}

export type NewVersionAction = "none" | "reload" | "block";

// loaded : version du bundle de l'onglet ; served : version annoncee par le serveur ;
// reloadedFor : version pour laquelle l'onglet a deja recharge (sessionStorage).
// Un onglet perime n'est jamais laisse utilisable (Samuel le 10/11) : rechargement force,
// redaction en cours comprise (copie locale des brouillons, lib/draft-backup.ts). Si le
// rechargement a deja eu lieu pour cette version sans changer le bundle (cache), la page
// reste bloquee avec un bouton, sans boucle de rechargements.
export function onNewVersion(s: { loaded: string; served: string | null; reloadedFor: string | null }): NewVersionAction {
	if (!s.served || s.served === s.loaded) return "none";
	return s.reloadedFor === s.served ? "block" : "reload";
}

// Next.js repond a une action serveur inconnue (ancien bundle) par un 404 portant cet en-tete.
export function isStaleActionResponse(headers: { get(name: string): string | null } | null | undefined): boolean {
	return headers?.get("x-nextjs-action-not-found") === "1";
}
