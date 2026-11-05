// Sending identity of a reply or forward. The `messages` row of a message present in
// several identities of the same user (sent from A to B: Sent of A and Inbox of B, matched
// by Message-ID) can change folder as IMAP syncs run: the identity of its folder is not
// stable. Priority:
//   (a) explicit `identity` parameter (already checked by access.ts);
//   (b) one of the user's identities whose address appears in To, Cc or Delivered-To of the
//       original message (in that order, then address order);
//   (c) the identity of the folder of the `messages` row;
//   (d) otherwise an explicit error listing the possible identities.
// Pure function, tested without a database (apps/worker/test/sender-identity.ts).

export type SenderIdentityCandidate = { id: string; value: string };

type AddressList = { value?: Array<{ address?: string | null }> | null } | string | null | undefined;

const addressesOf = (list: AddressList): string[] => {
	if (!list) return [];
	if (typeof list === "string")
		return list
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
	return (list.value ?? [])
		.map((a) => (a?.address ?? "").trim().toLowerCase())
		.filter(Boolean);
};

export function pickSenderIdentity<T extends SenderIdentityCandidate>(opts: {
	identities: T[];
	message: { to?: AddressList; cc?: AddressList; deliveredTo?: string | null };
	explicit?: T | null;
	mailboxIdentityId?: string | null;
}): { identity: T; reason: "explicit" | "recipient" | "mailbox" } {
	if (opts.explicit) return { identity: opts.explicit, reason: "explicit" };
	const byAddress = new Map(opts.identities.map((i) => [i.value.trim().toLowerCase(), i]));
	for (const addr of [
		...addressesOf(opts.message.to),
		...addressesOf(opts.message.cc),
		...addressesOf(opts.message.deliveredTo),
	]) {
		const hit = byAddress.get(addr);
		if (hit) return { identity: hit, reason: "recipient" };
	}
	const own = opts.identities.find((i) => i.id === opts.mailboxIdentityId);
	if (own) return { identity: own, reason: "mailbox" };
	throw new Error(
		`No sending identity could be derived for this message; pass 'identity' (${opts.identities.map((i) => i.value).join(", ") || "none"})`,
	);
}
