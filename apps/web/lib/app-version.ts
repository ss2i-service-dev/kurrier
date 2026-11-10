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

export type NewVersionAction = "none" | "reload" | "prompt";

// loaded : version du bundle de l'onglet ; served : version annoncee par le serveur ;
// reloadedFor : version pour laquelle l'onglet a deja recharge (sessionStorage) ;
// composing : un mail est en cours de redaction.
export function onNewVersion(s: {
	loaded: string;
	served: string | null;
	reloadedFor: string | null;
	composing: boolean;
}): NewVersionAction {
	if (!s.served || s.served === s.loaded) return "none";
	if (s.composing || s.reloadedFor === s.served) return "prompt";
	return "reload";
}
