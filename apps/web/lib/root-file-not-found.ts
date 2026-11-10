// Files of public/ served at the root that the proxy matcher does not already let through
// (svg/png/jpg/jpeg/gif/webp images and favicon.ico are excluded from it). The test
// apps/web/test/root-file-not-found.ts compares this list with the content of public/: a file
// added without being declared here makes it fail.
export const PUBLIC_ROOT_FILES = new Set<string>(["/keyboard-shortcuts.js"]);

const LOCALES = ["en", "ko"];

// Prefixes that are not localized pages and that the proxy leaves to their own route.
const PASS_THROUGH = ["/api/", "/oauth/", "/.well-known/", "/_next/"];

export function isUnknownRootFile(pathname: string): boolean {
	if (PASS_THROUGH.some((p) => pathname.startsWith(p))) return false;
	if (LOCALES.some((l) => pathname === `/${l}` || pathname.startsWith(`/${l}/`))) return false;
	if (PUBLIC_ROOT_FILES.has(pathname)) return false;
	// First segment carrying an extension (/x.yaml, /.env, /a.b/c): never a page.
	const first = pathname.split("/")[1] ?? "";
	return /\.[a-z0-9]+$/i.test(first) || /^\.[^/]+$/.test(first);
}
