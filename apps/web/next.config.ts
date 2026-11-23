import type { NextConfig } from "next";
import { formatBuildVersion } from "./lib/app-version";

// Build number, the same in the bundle and in /api/version (version watcher). A pipeline can
// set NEXT_PUBLIC_BUILD_VERSION (commit, tag); otherwise the build date is used. It is written
// back to the environment so that the processes started by the build (which load this file
// again) inherit it instead of computing another minute.
process.env.NEXT_PUBLIC_BUILD_VERSION ||= formatBuildVersion(new Date());
const buildVersion = process.env.NEXT_PUBLIC_BUILD_VERSION;

const nextConfig: NextConfig = {
	devIndicators: false,
	env: { NEXT_PUBLIC_BUILD_VERSION: buildVersion },
	output: "standalone",
	serverExternalPackages: ["pino", "pino-pretty", "thread-stream"],
	reactCompiler: true,
	experimental: {
		proxyClientMaxBodySize: "10gb",
	},
	// cacheComponents: true,
	// /_next/image is excluded from the proxy.ts matcher, so it sits outside the session guard; hostname "**"
	// made it an open proxy (any http(s) URL, internal network included). Only the avatar hosts of the code
	// remain: Gravatar and the placehold.co fallback. Contact avatars (signed S3 URLs) go through next/image
	// as `unoptimized`: not through the optimizer, so not in this list. Test apps/web/test/image-hosts.ts.
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
