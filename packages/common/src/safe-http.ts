// Outgoing HTTP requests to URLs coming from outside (user webhooks, unsubscribe links of
// mails). The server must never follow them into its internal network (SSRF): all the
// addresses of the name must be public, and the check is redone at connection time
// (http.request lookup), so a DNS rebinding between the check and the request does not
// get through. Redirects are never followed here: the caller decides (and rechecks the
// next URL).
// Node-only module: imported through "@common/safe-http", never by the package index.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export function isPrivateIp(ip: string): boolean {
	if (net.isIPv4(ip)) {
		const [a, b] = ip.split(".").map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}
	const v = ip.toLowerCase();
	// IPv4 mapped in IPv6, dotted form (::ffff:127.0.0.1) or hexadecimal (::ffff:7f00:1),
	// and NAT64 prefix 64:ff9b::/96: the IPv4 is in the last 32 bits.
	const mapped = v.match(/^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
	if (mapped) {
		if (mapped[1]) return isPrivateIp(mapped[1]);
		const hi = parseInt(mapped[2], 16);
		const lo = parseInt(mapped[3], 16);
		return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	if (v.startsWith("::ffff:") || v.startsWith("64:ff9b:")) return true;
	return (
		v === "::" ||
		v === "::1" ||
		v.startsWith("fc") ||
		v.startsWith("fd") ||
		v.startsWith("fe8") ||
		v.startsWith("fe9") ||
		v.startsWith("fea") ||
		v.startsWith("feb") ||
		v.startsWith("ff")
	);
}

const hostOf = (u: URL) => u.hostname.replace(/^\[|\]$/g, "");

export async function assertPublicUrl(raw: string, opts: { allowHttp?: boolean } = {}): Promise<URL> {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new Error("Invalid URL");
	}
	if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) {
		throw new Error(opts.allowHttp ? "URL must be http or https" : "URL is not https");
	}
	if (u.username || u.password) throw new Error("URL must not carry credentials");
	const host = hostOf(u);
	const addrs = net.isIP(host)
		? [host]
		: (await dns.promises.lookup(host, { all: true })).map((a) => a.address);
	if (!addrs.length || addrs.some(isPrivateIp)) {
		throw new Error("URL points to a private address");
	}
	return u;
}

// Resolution done at connection time: refuses the name if any of its addresses is
// private (same rule as assertPublicUrl).
export const publicLookup = ((hostname: string, options: any, callback: any) => {
	dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
		if (err) return callback(err);
		const list = addresses as unknown as dns.LookupAddress[];
		if (!list.length || list.some((a) => isPrivateIp(a.address))) {
			return callback(new Error(`${hostname} resolves to a private address`));
		}
		if (options?.all) return callback(null, list);
		return callback(null, list[0].address, list[0].family);
	});
}) as net.LookupFunction;

export type PublicHttpResponse = { status: number; location: string | null };

// One request, without following redirects; the response body is not read.
export async function publicHttpRequest(
	raw: string,
	opts: {
		method: string;
		headers?: Record<string, string>;
		body?: string;
		timeoutMs?: number;
		allowHttp?: boolean;
	},
): Promise<PublicHttpResponse> {
	const u = await assertPublicUrl(raw, { allowHttp: opts.allowHttp });
	const mod = u.protocol === "https:" ? https : http;
	const body = opts.body !== undefined ? Buffer.from(opts.body) : undefined;
	return await new Promise<PublicHttpResponse>((resolve, reject) => {
		const req = mod.request(
			u,
			{
				method: opts.method,
				headers: {
					...(opts.headers ?? {}),
					...(body ? { "Content-Length": String(body.length) } : {}),
				},
				lookup: publicLookup,
				timeout: opts.timeoutMs ?? 15_000,
			},
			(res) => {
				res.resume();
				const loc = res.headers.location;
				resolve({ status: res.statusCode ?? 0, location: typeof loc === "string" ? loc : null });
			},
		);
		req.on("timeout", () => req.destroy(new Error("Request timed out")));
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}
