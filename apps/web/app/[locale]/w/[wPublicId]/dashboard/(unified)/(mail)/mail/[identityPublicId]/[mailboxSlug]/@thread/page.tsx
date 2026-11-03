// ss2i : sans page ici, une navigation interne vers la liste (fermeture d'un fil)
// laisse l'emplacement @thread sur le fil precedent (comportement des routes
// paralleles de Next) ; l'actualisation suivante ne correspond alors plus et Next
// recharge toute la page. Une page vide ferme vraiment le fil. Rendu identique a
// default.tsx (rien) dans les deux interfaces.
export default function NoThread() {
	return null;
}
