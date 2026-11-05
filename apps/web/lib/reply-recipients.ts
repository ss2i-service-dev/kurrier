import type { MessageEntity } from "@db";

type Addr = { address?: string | null; name?: string | null };

function addressesOf(message: MessageEntity | null | undefined, field: "from" | "to" | "cc"): Addr[] {
	const v: any = (message as any)?.[field];
	if (!v) return [];
	if (typeof v === "string") return [{ address: v, name: "" }];
	return Array.isArray(v.value) ? v.value : [];
}

// Recipients of a reply. "to" = Reply-To if present, otherwise the sender;
// "cc" (reply all) = all other recipients of the message, without our own
// addresses or those already in "to".
export function replyRecipients(
	message: MessageEntity | null | undefined,
	ownAddresses: Iterable<string>,
) {
	const own = new Set(Array.from(ownAddresses).map((a) => a.toLowerCase()));
	const replyTo = Array.isArray((message as any)?.replyTo)
		? ((message as any).replyTo as Array<{ email?: string }>)
				.map((r) => r?.email)
				.filter(Boolean)
		: [];
	const from = addressesOf(message, "from").map((a) => a.address).filter(Boolean) as string[];
	const to = (replyTo.length ? (replyTo as string[]) : from).filter(Boolean);
	const toLower = new Set(to.map((a) => a.toLowerCase()));

	const seen = new Set<string>();
	const cc: string[] = [];
	for (const a of [...addressesOf(message, "to"), ...addressesOf(message, "cc")]) {
		const addr = String(a?.address ?? "").trim();
		if (!addr) continue;
		const key = addr.toLowerCase();
		if (own.has(key) || toLower.has(key) || seen.has(key)) continue;
		seen.add(key);
		cc.push(addr);
	}
	return { to, cc };
}
