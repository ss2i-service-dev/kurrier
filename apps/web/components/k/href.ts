// Internal addresses with the language prefix (/en/w/...). App links are
// written without it (/w/...) and the proxy redirects them (307) to /en/...;
// for an internal Next navigation (RSC request) that redirect drops the _rsc
// parameter and the router ends up reloading the whole page. With the prefix,
// there is no redirect.
const LOCALES = ["en", "ko"];

export function kHref(path: string): string {
	if (!path.startsWith("/w/")) return path;
	if (typeof window === "undefined") return `/en${path}`;
	const first = window.location.pathname.split("/")[1];
	return `/${LOCALES.includes(first) ? first : "en"}${path}`;
}
