import dns from "node:dns/promises";
import net from "node:net";

// ss2i : les URL de desinscription viennent d'en-tetes de courriers non sollicites : le
// serveur ne doit jamais les suivre vers son reseau interne (SSRF). https seulement, et
// toutes les adresses du nom doivent etre publiques. Risque residuel : un rebinding DNS entre
// ce controle et le fetch (resolution refaite par fetch) reste possible ; il est attenue par
// l'exigence https (le certificat doit valoir pour le nom) et la reponse n'est jamais lue.
function isPrivateIp(ip: string): boolean {
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
			a >= 224
		);
	}
	const v = ip.toLowerCase();
	// IPv4 mappee en IPv6, forme pointee (::ffff:127.0.0.1) ou hexadecimale (::ffff:7f00:1),
	// et prefixe NAT64 64:ff9b::/96 : l'IPv4 est dans les 32 derniers bits.
	const mapped = v.match(/^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
	if (mapped) {
		if (mapped[1]) return isPrivateIp(mapped[1]);
		const hi = parseInt(mapped[2], 16);
		const lo = parseInt(mapped[3], 16);
		return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
	}
	if (v.startsWith("::ffff:") || v.startsWith("64:ff9b:")) return true;
	return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb");
}

export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		throw new Error("Invalid unsubscribe URL");
	}
	if (u.protocol !== "https:") throw new Error("Unsubscribe URL is not https");
	const host = u.hostname.replace(/^\[|\]$/g, "");
	const addrs = net.isIP(host)
		? [host]
		: (await dns.lookup(host, { all: true })).map((a) => a.address);
	if (!addrs.length || addrs.some(isPrivateIp)) {
		throw new Error("Unsubscribe URL points to a private address");
	}
	return u;
}
