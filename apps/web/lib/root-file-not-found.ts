// ss2i : un chemin de fichier a la racine qui n'existe pas (/docker-compose.yaml, /.env,
// /..%2F.env) tombait dans app/[locale] avec « docker-compose.yaml » pour locale. Le
// notFound() du segment arrivait apres le debut du streaming (app/loading.tsx pose une
// frontiere Suspense a la racine) : la page 404 partait avec le statut 200. Le rapport de
// securite CrowdSec du 06/11/2026 y a vu une ressource servie sur un chemin d'attaque.
// Le proxy repond donc 404 lui-meme, avant tout rendu, a tout fichier racine inconnu.

// Fichiers de public/ servis a la racine et que le matcher du proxy ne laisse pas deja
// passer (les images svg/png/jpg/jpeg/gif/webp et favicon.ico en sont exclues). Le test
// apps/web/test/root-file-not-found.ts compare cette liste au contenu de public/ : un
// fichier ajoute sans etre declare ici fait echouer le build.
export const PUBLIC_ROOT_FILES = new Set<string>(["/ss2i-shortcuts.js"]);

const LOCALES = ["en", "ko"];

// Prefixes qui ne sont pas des pages localisees et que le proxy laisse a leur route.
const PASS_THROUGH = ["/api/", "/oauth/", "/.well-known/", "/_next/"];

export function isUnknownRootFile(pathname: string): boolean {
	if (PASS_THROUGH.some((p) => pathname.startsWith(p))) return false;
	if (LOCALES.some((l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`))) return false;
	if (PUBLIC_ROOT_FILES.has(pathname)) return false;
	// Premier segment portant une extension (/x.yaml, /.env, /a.b/c) : jamais une page.
	const first = pathname.split("/")[1] ?? "";
	return /\.[a-z0-9]+$/i.test(first) || /^\.[^/]+$/.test(first);
}
