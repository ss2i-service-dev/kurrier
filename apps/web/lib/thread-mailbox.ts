import { fetchMailbox } from "@/lib/actions/mailbox";

// ss2i : dossier d'un fil ouvert. Un fil ouvert depuis la vue Clients passe par la route
// interceptee @thread/(.)threads avec mailboxSlug = "clients" (segment de la page d'ou l'on
// vient), qui n'est pas un dossier : fetchMailbox levait « Mailbox not found » et la page
// tombait en « This page couldn't load » (un F5 passait, sans interception). Si le dossier de
// l'URL n'existe pas pour l'identite, on prend celui du message le plus recent du fil.
export async function fetchThreadMailbox(
	identityPublicId: string,
	mailboxSlug: string,
	messages: { mailboxId: string | null }[],
) {
	try {
		return await fetchMailbox(identityPublicId, mailboxSlug);
	} catch (e) {
		if (!String((e as Error)?.message).startsWith("Mailbox not found")) throw e;
	}
	const { mailboxList } = await fetchMailbox(identityPublicId, "inbox");
	const byId = new Map(mailboxList.map((m) => [String(m.id), m]));
	const own = [...messages]
		.reverse()
		.map((m) => byId.get(String(m.mailboxId)))
		.find(Boolean);
	return fetchMailbox(identityPublicId, own?.slug ?? "inbox");
}
