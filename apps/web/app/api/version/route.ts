// Version of the running build, never cached: the version watcher
// (components/common/version-watcher.tsx) compares it with the one of its bundle.
export const dynamic = "force-dynamic";

export function GET() {
	return Response.json(
		{ version: process.env.NEXT_PUBLIC_BUILD_VERSION ?? "" },
		{ headers: { "Cache-Control": "no-store, max-age=0" } },
	);
}
