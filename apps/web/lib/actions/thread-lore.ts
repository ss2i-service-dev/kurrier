"use server";
// ss2i : « Répondre avec Lore » depuis un fil ouvert (OI 10288). La conversation, jusqu'au
// message auquel on répond (le dernier par défaut), part à Lore avec la consigne facultative ;
// le corps rédigé par Lore devient un brouillon de réponse du fil, par le même chemin que
// l'éditeur (saveDraft : ligne Drafts, puis version IMAP par le job draft:sync) et avec les
// mêmes réglages que le MCP `reply` en as_draft (citation du dernier message, signature et
// style RFC de l'utilisateur appliqués à l'envoi). Rien n'est envoyé : le brouillon s'ouvre
// dans l'éditeur du fil pour relecture. L'identité et le fil sont lus par la connexion RLS.
// Requête, coupes et erreurs dans @common/lore-reply.
import { and, eq } from "drizzle-orm";
import { identities, type MessageEntity, mailboxThreads, messages } from "@db";
import { getServerEnv } from "@schema";
import { DEFAULT_PRO_DOMAINS, parseDomainList } from "@common/crm-match";
import {
	LoreError,
	type LoreSource,
	loreActAs,
	loreConfigMessage,
	loreConfigMissing,
	loreDraftBody,
	loreDraftRecipients,
	loreReplyRequest,
	loreReplySubject,
	requestLoreReply,
} from "@common/lore-reply";
import { isSignedIn } from "@/lib/actions/auth";
import { rlsClient } from "@/lib/actions/clients";
import { flushDraft, saveDraft } from "@/lib/actions/drafts";
import { type CopyAddress, fetchMessagesForCopy } from "@/lib/actions/mail-copy";
import { fetchThreadClients } from "@/lib/actions/thread-clients";
import { replyRecipients } from "@/lib/reply-recipients";

export type LoreReplyResult =
	| { ok: true; draftMessageId: string; subject: string; model: string | null; sources: LoreSource[] }
	| { ok: false; error: string };

const label = (a: CopyAddress) => (a.name && a.address ? `${a.name} <${a.address}>` : a.address || a.name || "");
const labels = (list: CopyAddress[]) => list.map(label).filter(Boolean);
const addresses = (list: CopyAddress[]) => list.map((a) => String(a.address ?? "").trim()).filter(Boolean);

/** Variables manquantes du service web (vide = bouton utilisable). */
export async function loreReplyConfig(): Promise<{ missing: string[]; message: string | null }> {
	if (!(await isSignedIn())) return { missing: [], message: "Session expirée : reconnectez-vous." };
	const missing = loreConfigMissing(getServerEnv());
	return { missing, message: missing.length ? loreConfigMessage(missing) : null };
}

/** Brouillon de réponse rédigé par Lore, rattaché au fil (rien n'est envoyé). */
export async function replyWithLore(input: {
	threadId: string;
	identityPublicId: string;
	/** Message auquel on répond (en-tête d'un message, interface classique) ; défaut : le dernier. */
	messageId?: string | null;
	instruction?: string | null;
}): Promise<LoreReplyResult> {
	const started = Date.now();
	try {
		const user = await isSignedIn();
		if (!user?.email) throw new LoreError("Session expirée : reconnectez-vous.");
		const env = getServerEnv();
		const missing = loreConfigMissing(env);
		if (missing.length) throw new LoreError(loreConfigMessage(missing));

		const threadId = String(input.threadId);
		const identityPublicId = String(input.identityPublicId);
		const rls = await rlsClient();
		const own = await rls((tx) =>
			tx.select({ id: identities.id, publicId: identities.publicId, value: identities.value }).from(identities).where(eq(identities.kind, "email")),
		);
		const ident = own.find((i) => i.publicId === identityPublicId);
		if (!ident) throw new LoreError("Boîte introuvable.");
		const [place] = await rls((tx) =>
			tx
				.select({ threadId: mailboxThreads.threadId })
				.from(mailboxThreads)
				.where(and(eq(mailboxThreads.threadId, threadId), eq(mailboxThreads.identityId, ident.id)))
				.limit(1),
		);
		if (!place) throw new LoreError("Ce fil n'est pas dans cette boîte.");

		// Conversation jusqu'au message auquel on répond (brouillons exclus, ordre chronologique).
		const rows = await fetchMessagesForCopy({ threadId });
		if (!rows.length) throw new LoreError("Ce fil ne contient aucun message.");
		const at = input.messageId ? rows.findIndex((r) => r.id === String(input.messageId)) : rows.length - 1;
		if (at < 0) throw new LoreError("Ce message n'est plus dans le fil : rechargez la page.");
		const replied = rows[at];
		const [entity] = await rls((tx) =>
			tx
				.select({ id: messages.id, from: messages.from, to: messages.to, cc: messages.cc, replyTo: messages.replyTo })
				.from(messages)
				.where(eq(messages.id, replied.id))
				.limit(1),
		);
		if (!entity) throw new LoreError("Ce message n'est plus dans le fil : rechargez la page.");

		const companies = await fetchThreadClients(threadId, identityPublicId).catch(() => []);
		const request = loreReplyRequest({
			mailbox: ident.value,
			subject: replied.subject ?? rows[0].subject,
			messages: rows.slice(0, at + 1).map((m) => ({
				from: labels(m.from).join(", "),
				to: labels(m.to),
				cc: labels(m.cc),
				date: m.date,
				text: m.text,
				html: m.html,
				attachments: m.attachments,
			})),
			instruction: input.instruction,
			crmCompanyIds: companies.map((c) => c.companyId),
		});
		const reply = await requestLoreReply(
			{ url: env.LORE_URL!, token: env.LORE_APP_TOKEN!, actAs: loreActAs({
					accountEmail: user.email,
					threadIdentity: ident.value,
					identities: own.map((i) => i.value),
					proDomains: parseDomainList(env.CRM_PRO_DOMAINS, DEFAULT_PRO_DOMAINS),
				}),
			},
			request,
		);

		// Répondre à tous, comme le bouton de l'éditeur ; relance d'un message envoyé par nous :
		// ses destinataires.
		const ownAddresses = own.map((i) => String(i.value));
		const computed = replyRecipients(entity as unknown as MessageEntity, ownAddresses);
		const { to, cc } = loreDraftRecipients(
			{ to: computed.to, cc: computed.cc },
			{ from: addresses(replied.from), to: addresses(replied.to), cc: addresses(replied.cc) },
			ownAddresses,
		);
		if (!to.length) throw new LoreError("Aucun destinataire ne se déduit de ce message.");
		const body = loreDraftBody(reply);
		const subject = loreReplySubject(replied.subject);
		const saved = await saveDraft({
			identityPublicId,
			to,
			cc,
			subject,
			html: body.html,
			text: body.text,
			mode: "reply",
			originalMessageId: replied.id,
			includeSignature: true,
			quoteScope: "last",
		});
		if (saved.error !== undefined) throw new LoreError(`Brouillon non enregistré : ${saved.error}`);
		await flushDraft(identityPublicId, saved.draftMessageId);
		console.info(
			`[lore] brouillon ${saved.draftMessageId} fil ${threadId} (${request.messages.length} messages, ${reply.model ?? "modèle ?"}, ${Date.now() - started} ms)`,
		);
		return { ok: true, draftMessageId: saved.draftMessageId, subject, model: reply.model, sources: reply.sources };
	} catch (err) {
		if (err instanceof LoreError) {
			console.warn(`[lore] fil ${input.threadId} : ${err.message} (${Date.now() - started} ms)`);
			return { ok: false, error: err.message };
		}
		console.error("[lore] réponse", err);
		return { ok: false, error: "Erreur inattendue, voir le journal du serveur." };
	}
}
