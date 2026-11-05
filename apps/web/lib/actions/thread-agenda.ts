"use server";
// ss2i : « Ajouter a l'agenda » depuis un fil ouvert (OI 10280). Deux temps : analyse du fil
// par le LLM (propositions), puis creation des evenements valides par l'utilisateur dans
// l'agenda Outlook de la boite du fil (Microsoft Graph, app-only). L'identite et le fil sont
// lus par la connexion RLS : un fil ou une identite d'un autre utilisateur n'existent pas.
// Seules les boites M365 de BRIDGE_MAILBOXES sont ecrites (l'app Graph peut ecrire dans
// tous les agendas du tenant). Logique et appels HTTP dans @common/thread-agenda.
import { and, asc, eq, sql } from "drizzle-orm";
import { identities, mailboxThreads, messages } from "@db";
import { getPublicEnv, getServerEnv } from "@schema";
import { DEFAULT_PRO_DOMAINS, isProIdentity, parseDomainList } from "@common/crm-match";
import {
	AgendaError,
	type AgendaEvent,
	agendaTranscript,
	createGraphEvent,
	extractAgendaEvents,
	graphEventBody,
	normalizeAgendaEvent,
	parseMailboxList,
} from "@common/thread-agenda";
import { getWorkspacePublicId, rlsClient } from "@/lib/actions/clients";
import { type CopyAddress, fetchMessagesForCopy } from "@/lib/actions/mail-copy";

export type AgendaAnalysis =
	| { ok: true; mailbox: string; events: AgendaEvent[] }
	| { ok: false; error: string };

export type AgendaAddResult =
	| { ok: true; mailbox: string; results: { ok: boolean; error?: string; webLink?: string }[] }
	| { ok: false; error: string };

// Boite de l'identite (RLS) et dossiers du fil dans cette identite.
async function threadMailbox(identityPublicId: string, threadId: string) {
	const rls = await rlsClient();
	const [ident] = await rls((tx) =>
		tx
			.select({ id: identities.id, value: identities.value })
			.from(identities)
			.where(and(eq(identities.publicId, String(identityPublicId)), eq(identities.kind, "email")))
			.limit(1),
	);
	if (!ident) throw new AgendaError("Boîte introuvable.");
	const places = await rls((tx) =>
		tx
			.select({ slug: mailboxThreads.mailboxSlug })
			.from(mailboxThreads)
			.where(and(eq(mailboxThreads.threadId, String(threadId)), eq(mailboxThreads.identityId, ident.id))),
	);
	if (!places.length) throw new AgendaError("Ce fil n'est pas dans cette boîte.");
	return { address: ident.value.trim().toLowerCase(), slugs: places.map((p) => p.slug).filter((s): s is string => !!s) };
}

// Configuration du serveur et droit d'ecrire dans l'agenda de cette adresse.
function agendaConfig(address: string) {
	const env = getServerEnv();
	const missing = (["ANTHROPIC_API_KEY", "GRAPH_TENANT", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "BRIDGE_MAILBOXES"] as const).filter(
		(k) => !env[k]?.trim(),
	);
	if (missing.length) {
		throw new AgendaError(
			`Ajout à l'agenda non configuré sur le serveur : ${missing.length > 1 ? "variables manquantes" : "variable manquante"} ${missing.join(", ")} (service web).`,
		);
	}
	if (!parseMailboxList(env.BRIDGE_MAILBOXES).includes(address)) {
		throw new AgendaError(
			`${address} n'est pas une boîte Microsoft 365 du tenant (BRIDGE_MAILBOXES) : son agenda Outlook n'est pas accessible.`,
		);
	}
	return {
		apiKey: env.ANTHROPIC_API_KEY!.trim(),
		graph: { tenant: env.GRAPH_TENANT!.trim(), clientId: env.GRAPH_CLIENT_ID!.trim(), clientSecret: env.GRAPH_CLIENT_SECRET!.trim() },
	};
}

const failure = (where: string, err: unknown) => {
	if (err instanceof AgendaError) return { ok: false as const, error: err.message };
	console.error(`[agenda] ${where}`, err);
	return { ok: false as const, error: "Erreur inattendue, voir le journal du serveur." };
};

const addressLabel = (list: CopyAddress[]) =>
	list
		.map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.address || a.name || ""))
		.filter(Boolean)
		.join(", ");

/**
 * Bouton visible pour une identite de l'utilisateur dont la boite est dans BRIDGE_MAILBOXES,
 * ou, tant que cette liste n'est pas renseignee, pour une identite pro (le clic dit alors ce
 * qui manque a la configuration).
 */
export async function agendaAvailable(identityPublicId: string): Promise<boolean> {
	try {
		const rls = await rlsClient();
		const [ident] = await rls((tx) =>
			tx
				.select({ value: identities.value })
				.from(identities)
				.where(and(eq(identities.publicId, String(identityPublicId)), eq(identities.kind, "email")))
				.limit(1),
		);
		if (!ident) return false;
		const env = getServerEnv();
		const boxes = parseMailboxList(env.BRIDGE_MAILBOXES);
		if (boxes.length) return boxes.includes(ident.value.trim().toLowerCase());
		return isProIdentity(ident.value, parseDomainList(env.CRM_PRO_DOMAINS, DEFAULT_PRO_DOMAINS));
	} catch {
		return false;
	}
}

/** Propositions d'evenements pour le fil (rien n'est cree). */
export async function analyzeThreadForAgenda(input: {
	threadId: string;
	identityPublicId: string;
	/** Ce que l'utilisateur veut creer, quand le fil ne donne pas (ou pas seul) l'evenement. */
	request?: string;
}): Promise<AgendaAnalysis> {
	try {
		const { address } = await threadMailbox(input.identityPublicId, input.threadId);
		const cfg = agendaConfig(address);
		const rows = await fetchMessagesForCopy({ threadId: String(input.threadId) });
		if (!rows.length) throw new AgendaError("Ce fil ne contient aucun message.");
		const transcript = agendaTranscript({
			subject: rows[rows.length - 1].subject ?? rows[0].subject,
			mailbox: address,
			messages: rows.map((m) => ({ from: addressLabel(m.from), date: m.date, text: m.text, html: m.html })),
		});
		const request = typeof input.request === "string" ? input.request.trim().slice(0, 1000) : "";
		const events = await extractAgendaEvents({ apiKey: cfg.apiKey }, transcript, request);
		return { ok: true, mailbox: address, events };
	} catch (err) {
		return failure("analyse", err);
	}
}

/** Cree dans l'agenda Outlook de la boite du fil les evenements valides par l'utilisateur. */
export async function addThreadEventsToAgenda(input: {
	threadId: string;
	identityPublicId: string;
	events: AgendaEvent[];
}): Promise<AgendaAddResult> {
	try {
		const { address, slugs } = await threadMailbox(input.identityPublicId, input.threadId);
		const cfg = agendaConfig(address);
		const list = Array.isArray(input.events) ? input.events.slice(0, 50) : [];
		if (!list.length) throw new AgendaError("Aucun événement à ajouter.");

		// Lien vers le fil : son dossier de reception de preference (le lien d'un autre
		// dossier reste valable, le fil est retrouve par son identifiant).
		const rls = await rlsClient();
		const [first] = await rls((tx) =>
			tx
				.select({ subject: messages.subject })
				.from(messages)
				.where(and(eq(messages.threadId, String(input.threadId)), eq(messages.draft, false)))
				.orderBy(asc(sql`coalesce(${messages.date}, ${messages.createdAt})`))
				.limit(1),
		);
		const slug = slugs.includes("inbox") ? "inbox" : (slugs.find((s) => s !== "trash" && s !== "spam") ?? slugs[0] ?? "inbox");
		const origin = String(getPublicEnv().WEB_URL ?? "").trim().replace(/\/+$/, "");
		const threadUrl = origin
			? `${origin}/w/${encodeURIComponent(await getWorkspacePublicId())}/dashboard/mail/${encodeURIComponent(input.identityPublicId)}/${encodeURIComponent(slug)}/threads/${encodeURIComponent(input.threadId)}`
			: undefined;

		const results: { ok: boolean; error?: string; webLink?: string }[] = [];
		for (const raw of list) {
			const n = normalizeAgendaEvent(raw);
			if ("error" in n) {
				results.push({ ok: false, error: n.error });
				continue;
			}
			try {
				const created = await createGraphEvent(cfg.graph, address, graphEventBody(n.event, { threadUrl, threadSubject: first?.subject }));
				results.push({ ok: true, webLink: created.webLink });
			} catch (err) {
				if (!(err instanceof AgendaError)) console.error("[agenda] creation", err);
				results.push({ ok: false, error: err instanceof AgendaError ? err.message : "Erreur inattendue, voir le journal du serveur." });
			}
		}
		return { ok: true, mailbox: address, results };
	} catch (err) {
		return failure("ajout", err);
	}
}
