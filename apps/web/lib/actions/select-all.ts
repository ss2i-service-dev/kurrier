"use server";
// ss2i : « tout selectionner » au-dela de la page affichee, comme Gmail : identifiants de
// tous les fils d'un dossier ou d'une recherche. Lecture sous RLS : seuls les fils du
// dossier de l'utilisateur reviennent, quel que soit ce que le navigateur envoie.
import Typesense from "typesense";
import { and, desc, eq, inArray } from "drizzle-orm";
import { mailboxThreads } from "@db";
import { getServerEnv } from "@schema";
import { rlsClient } from "@/lib/actions/clients";

// Plafond d'une selection : au-dela, les actions posteraient des milliers de jobs.
const SELECT_ALL_MAX = 5000;

export type SelectAllScope =
	| { kind: "mailbox"; mailboxId: string }
	| {
			kind: "search";
			mailboxId: string;
			q: string;
			workspacePublicId: string;
			identityPublicId: string;
			mailboxSlug: string;
			has: boolean;
			unread: boolean;
			starred: boolean;
	  };

export type SelectAllResult = { ids: string[]; truncated: boolean };

async function searchThreadIds(scope: Extract<SelectAllScope, { kind: "search" }>) {
	const { TYPESENSE_API_KEY, TYPESENSE_PORT, TYPESENSE_PROTOCOL, TYPESENSE_HOST } = getServerEnv();
	const client = new Typesense.Client({
		nodes: [{ host: TYPESENSE_HOST, port: Number(TYPESENSE_PORT), protocol: TYPESENSE_PROTOCOL }],
		apiKey: TYPESENSE_API_KEY,
	});
	// Memes filtres que initSearch (lib/actions/mailbox.ts).
	const filters = [
		`workspacePublicId:=${JSON.stringify(scope.workspacePublicId)}`,
		`identityPublicId:=${JSON.stringify(scope.identityPublicId)}`,
		`mailboxSlug:=${JSON.stringify(scope.mailboxSlug)}`,
	];
	if (scope.has) filters.push("hasAttachment:=1");
	if (scope.unread) filters.push("unread:=1");
	if (scope.starred) filters.push("starred:=1");

	const ids: string[] = [];
	const seen = new Set<string>();
	const PER_PAGE = 250; // maximum Typesense
	for (let page = 1; ids.length <= SELECT_ALL_MAX; page++) {
		const res = (await client.collections("messages").documents().search({
			q: scope.q.trim(),
			query_by: "subject,snippet,fromName,fromEmail,fromDomain,participants",
			filter_by: filters.join(" && "),
			sort_by: "createdAt:desc",
			group_by: "threadId",
			group_limit: 1,
			per_page: PER_PAGE,
			page,
			include_fields: "threadId",
		})) as any;
		const groups = (res?.grouped_hits ?? []) as Array<{ hits: Array<{ document: any }> }>;
		for (const g of groups) {
			const id = String(g.hits[0]?.document?.threadId ?? "");
			if (id && !seen.has(id)) {
				seen.add(id);
				ids.push(id);
			}
		}
		if (groups.length < PER_PAGE) break;
	}
	return ids;
}

export async function fetchAllThreadIds(scope: SelectAllScope): Promise<SelectAllResult> {
	if (!scope?.mailboxId) return { ids: [], truncated: false };
	const rls = await rlsClient();

	if (scope.kind === "mailbox") {
		const rows = await rls((tx) =>
			tx
				.select({ threadId: mailboxThreads.threadId })
				.from(mailboxThreads)
				.where(eq(mailboxThreads.mailboxId, scope.mailboxId))
				.orderBy(desc(mailboxThreads.lastActivityAt))
				.limit(SELECT_ALL_MAX + 1),
		);
		const ids = rows.map((r) => String(r.threadId));
		return { ids: ids.slice(0, SELECT_ALL_MAX), truncated: ids.length > SELECT_ALL_MAX };
	}

	if (!scope.q?.trim()) return { ids: [], truncated: false };
	const hits = await searchThreadIds(scope);
	// L'index peut avoir un temps de retard : on ne garde que les fils encore dans le dossier.
	const present = new Set<string>();
	for (let i = 0; i < hits.length; i += 1000) {
		const chunk = hits.slice(i, i + 1000);
		const rows = await rls((tx) =>
			tx
				.select({ threadId: mailboxThreads.threadId })
				.from(mailboxThreads)
				.where(and(eq(mailboxThreads.mailboxId, scope.mailboxId), inArray(mailboxThreads.threadId, chunk))),
		);
		rows.forEach((r) => present.add(String(r.threadId)));
	}
	const ids = hits.filter((id) => present.has(id));
	return { ids: ids.slice(0, SELECT_ALL_MAX), truncated: ids.length > SELECT_ALL_MAX };
}
