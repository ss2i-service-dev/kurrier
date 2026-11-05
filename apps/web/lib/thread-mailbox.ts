import { fetchMailbox } from "@/lib/actions/mailbox";
import { pickThreadMailboxSlug } from "@/lib/thread-mailbox-pick";

// ss2i : dossier d'un fil ouvert. Un fil ouvert depuis la vue Clients passe par la route
// interceptee @thread/(.)threads avec mailboxSlug = "clients" (segment de la page d'ou l'on
// vient), qui n'est pas un dossier. Si le dossier de l'URL n'existe pas pour l'identite, on
// prend celui du message le plus recent du fil.
//
// Le dossier se verifie dans la liste AVANT d'appeler fetchMailbox : depuis le 04/11 (URL
// jamais bloquante), fetchMailbox redirige vers l'Inbox sur un dossier inconnu au lieu de
// lever « Mailbox not found » ; l'ancien repli sur l'exception ne se declenchait plus et un
// clic sur un fil d'un dossier client renvoyait a l'Inbox (Samuel le 05/11).
// fetchMailbox est en cache() : l'appel « inbox » ne coute qu'une fois par requete.
export async function fetchThreadMailbox(
	identityPublicId: string,
	mailboxSlug: string,
	messages: { mailboxId: string | null }[],
) {
	const { mailboxList } = await fetchMailbox(identityPublicId, "inbox");
	if (mailboxList.some((m) => m.slug === mailboxSlug)) {
		return fetchMailbox(identityPublicId, mailboxSlug);
	}
	return fetchMailbox(identityPublicId, pickThreadMailboxSlug(mailboxList, messages) ?? "inbox");
}
