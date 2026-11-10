// Version du build en service, jamais en cache (regle appli-web-js) : le surveillant de
// version (components/common/version-watcher.tsx) la compare a celle de son bundle.
export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(
		{ version: process.env.NEXT_PUBLIC_BUILD_VERSION ?? "" },
		{ headers: { "Cache-Control": "no-store, max-age=0" } },
	);
}
