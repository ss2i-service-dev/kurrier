// Identite d'envoi d'une reponse ou d'un transfert. La ligne `messages` d'un message
// present dans plusieurs identites du meme utilisateur (envoye de A vers B : Sent de A
// et Inbox de B, rapproches par Message-ID) peut changer de dossier au gre des
// synchronisations IMAP : l'identite de son dossier n'est pas stable. Priorite :
//   (a) parametre explicite `identity` (deja controle par access.ts) ;
//   (b) une identite de l'utilisateur dont l'adresse figure en To, Cc ou Delivered-To
//       du message d'origine (dans cet ordre, puis l'ordre des adresses) ;
//   (c) l'identite du dossier de la ligne `messages` ;
//   (d) sinon erreur explicite listant les identites possibles.
// Fonction pure, testee sans base (apps/worker/test/sender-identity.ts).

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
