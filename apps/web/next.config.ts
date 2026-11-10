import type { NextConfig } from "next";
import { existsSync, readFileSync } from "node:fs";
import { formatBuildVersion } from "./lib/app-version";

// ss2i : numero de build (regle appli-web-js), le meme dans le bundle et dans /api/version.
// .patch-level est ecrit par Dockerfile.web (mail-souverain) : numero du dernier patch applique.
const patchLevel = existsSync(".patch-level") ? readFileSync(".patch-level", "utf8").trim() : "";
const buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION || formatBuildVersion(new Date(), patchLevel);

const nextConfig: NextConfig = {
	devIndicators: false,
	env: { NEXT_PUBLIC_BUILD_VERSION: buildVersion },
	output: "standalone",
	serverExternalPackages: ["pino", "pino-pretty", "thread-stream"],
	// ss2i (OI 10363) : les notes « Nouveautes » (apps/web/changelogs/*.md) sont lues a
	// l'execution ; la sortie standalone ne les copierait pas toute seule, et l'image les
	// perdrait sans que le Dockerfile ait a le savoir.
	outputFileTracingIncludes: { "/**": ["./changelogs/**/*"] },
	reactCompiler: true,
	experimental: {
		proxyClientMaxBodySize: "10gb",
		// ss2i : le corps du mail (images collees en data: URI) passe par les actions serveur
		// sendMail et saveDraft, et les pieces jointes des evenements Outlook (35 Mo en base64)
		// par saveOutlookEvent, limitees a 1 Mo par defaut.
		serverActions: { bodySizeLimit: "50mb" },
	},
	// cacheComponents: true,
	// ss2i (OI 10343) : /_next/image est exclu du matcher de proxy.ts, donc hors garde de
	// session ; hostname "**" en faisait un proxy ouvert (n'importe quelle URL http(s),
	// reseau interne compris). Seuls les hotes d'avatars du code restent : Gravatar et le
	// fallback placehold.co. Les avatars de contact (URL signees S3) passent par next/image
	// en `unoptimized` : pas par l'optimiseur, donc pas dans cette liste. Test
	// apps/web/test/image-hosts.ts.
	images: {
		remotePatterns: [
			{ protocol: "https", hostname: "www.gravatar.com", pathname: "/avatar/**" },
			{ protocol: "https", hostname: "placehold.co" },
		],
	},
	async rewrites() {
		return {
			beforeFiles: [
				{
					source: "/api/v1/:path*",
					destination: `${process.env.WORKER_URL}:3001/api/v1/:path*`,
				},
				{
					source: "/api/kurrier/:path*",
					destination: `${process.env.WORKER_URL}:3001/api/kurrier/:path*`,
				},

				{
					source: "/api/dav",
					destination: `${process.env.DAV_URL}/dav.php`,
				},
				{
					source: "/api/dav/:path*",
					destination: `${process.env.DAV_URL}/dav.php/:path*`,
				},
				{
					source: "/dav.php/:path*",
					destination: `${process.env.DAV_URL}/dav.php/:path*`,
				},
				{
					source: "/principals/:path*",
					destination: `${process.env.DAV_URL}/dav.php/principals/:path*`,
				},
				{
					source: "/.well-known/caldav",
					destination: `${process.env.DAV_URL}/dav.php`,
				},
				{
					source: "/.well-known/carddav",
					destination: `${process.env.DAV_URL}/dav.php`,
				},
			],
			afterFiles: [],
			fallback: [],
		};
	},
};

export default nextConfig;
