// ss2i : porte « une seule fois » pour onReady de l'editeur (defilement + focus a l'ouverture).
// Les parents passent une fonction flechee recreee a chaque rendu ; rejouer onReady a chaque
// rendu remettait le curseur sur « A » pendant qu'on modifiait un message transfere
// (Samuel le 06/11/2026). Test : apps/web/test/compose-focus.ts.
export function createReadyGate<T>() {
	let done = false;
	return {
		// Appelle cb(el) la premiere fois qu'un element existe ; renvoie true si cb est parti.
		fire(el: T | null | undefined, cb?: (el: T) => void): boolean {
			if (done || el == null) return false;
			done = true;
			cb?.(el);
			return true;
		},
	};
}
