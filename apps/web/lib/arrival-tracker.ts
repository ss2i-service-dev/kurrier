// ss2i : liseré des non lus sur un fil lu ou ouvert a l'ecran quand un message y arrive ensuite
// (8ddc39ce : l'affichage du nouveau message le marque lu aussitot au serveur). Le repere etait
// last_activity_at, que changent aussi une reponse envoyee (fil remonte, OI 10273) et la copie
// de mon propre mail recue par un alias (dev@) : le fil repassait non lu (Samuel le 18/11/2026).
// Repere : nombre de messages du fil dans ce dossier ; seul un message de plus dont l'expediteur
// du plus recent n'est pas une de mes adresses allume le liseré. Fonction pure, testee par
// apps/web/test/own-reply-not-unread.ts.

export type ArrivalSnapshot = { count: number; lastFrom: string | null | undefined };

export function createArrivalTracker() {
	const baseline = new Map<string, { count: number; arrived: boolean }>();
	return {
		/** track : le fil est ouvert ou lu a l'ecran (debut du suivi s'il n'est pas suivi). */
		arrived(threadId: string, snap: ArrivalSnapshot, own: Set<string>, track: boolean): boolean {
			const id = String(threadId);
			const count = Number(snap.count) || 0;
			const base = baseline.get(id);
			if (!base) {
				if (track) baseline.set(id, { count, arrived: false });
				return false;
			}
			if (count > base.count) {
				const mine = own.has(String(snap.lastFrom ?? "").trim().toLowerCase());
				if (!mine) base.arrived = true;
			}
			base.count = count;
			return base.arrived;
		},
		reset(threadId: string) {
			baseline.delete(String(threadId));
		},
	};
}
