import { fetchMailbox } from "@/lib/actions/mailbox";

// Mailbox of an open thread. The intercepted route @thread/(.)threads receives the mailbox
// segment of the page the user comes from, which is not always a mailbox (search, label
// views): fetchMailbox threw "Mailbox not found" and the page failed to load (a reload worked,
// without interception). If the mailbox of the URL does not exist for the identity, fall
// back to the mailbox of the most recent message of the thread.
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
