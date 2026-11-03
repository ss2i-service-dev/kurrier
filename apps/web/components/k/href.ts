// SS2i (Outlook) : adresses internes avec le prefixe de langue (/en/w/...).
// Les liens de l'application sont ecrits sans (/w/...) et le proxy les
// redirige (307) vers /en/... ; pour une navigation interne de Next (requete
// RSC), cette redirection perd le parametre _rsc et le routeur finit par
// recharger toute la page. Avec le prefixe, pas de redirection.
const LOCALES = ["en", "ko"];

export function kHref(path: string): string {
	if (!path.startsWith("/w/")) return path;
	if (typeof window === "undefined") return `/en${path}`;
	const first = window.location.pathname.split("/")[1];
	return `/${LOCALES.includes(first) ? first : "en"}${path}`;
}
