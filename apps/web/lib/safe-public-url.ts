import { assertPublicUrl } from "@common/safe-http";

// Unsubscribe URLs come from headers of unsolicited mail: the server must never follow them
// into its internal network (SSRF). https only, and every address of the host name must be
// public. The rule and the request (address re-checked at connection time, against DNS
// rebinding) are in @common/safe-http.
export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
	try {
		return await assertPublicUrl(raw);
	} catch (e: any) {
		throw new Error(`Unsubscribe URL rejected: ${e?.message ?? e}`);
	}
}
