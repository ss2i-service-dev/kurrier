import { getTimeZones } from "@vvo/tzdb";

// ss2i : getTimeZones() recalcule les decalages des ~400 fuseaux a chaque appel (~80 ms).
// Appele dans chaque ligne de la liste (bouton Snooze), il coutait 4 s de CPU serveur au
// rendu d'une boite de 50 fils. La table ne change pas pendant la vie du processus.
let cached: ReturnType<typeof getTimeZones> | undefined;
export const cachedTimeZones = () => (cached ??= getTimeZones());
