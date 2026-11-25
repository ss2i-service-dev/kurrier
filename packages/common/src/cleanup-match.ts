import { cleanupCutoff, cleanupQueryError, cleanupSearchParams, type CleanupRow, type CleanupScope } from "./cleanup-rules";
import { eligibleCleanupThreads } from "./cleanup-eligible";

// ss2i : nettoyage automatique, matcher commun (docs/plans/nettoyage-auto-recherche.md, MT4). Le meme
// code sert au compte de la creation et au tick : Typesense strict ne fournit que des candidats (ids de
// fils), eligibleCleanupThreads decide en SQL (identite, dossiers, age, etoile, report, filtres). L'index
// peut etre en retard ou incoherent : un candidat inegible est ecarte, un fil absent de l'index attend
// le passage suivant. `search` est injecte (aucun client Typesense ici : web et worker donnent le leur).
// Le scope vient de resolveCleanupScope ou loadCleanupRule (relu en base), jamais du client ; la requete
// est revalidee a chaque appel (cleanupQueryError), comme par la contrainte de la table.

type Search = (params: any) => Promise<any>;
type Dbh = { execute: (q: any) => Promise<any> };

// Fils eligibles du scope, dans l'ordre de l'index (message le plus ancien d'abord), au plus `limit` fils
// distincts (toutes leurs lignes de dossier sont rendues). truncated : la limite est atteinte ou la
// derniere page autorisee etait pleine, il peut en rester. Une erreur de `search` remonte a l'appelant.
export async function matchCleanup(
	{ search, dbh }: { search: Search; dbh: Dbh },
	scope: CleanupScope,
	o: { now: Date; limit: number; maxPages: number },
): Promise<{ rows: CleanupRow[]; truncated: boolean }> {
	const empty = { rows: [] as CleanupRow[], truncated: false };
	const limit = Math.floor(o.limit);
	const maxPages = Math.floor(o.maxPages);
	if (cleanupQueryError(scope.query) || !scope.mailboxIds.length || !(limit >= 1) || !(maxPages >= 1)) return empty;
	const cutoff = cleanupCutoff(o.now, scope.retentionDays);
	const byThread = new Map<string, CleanupRow[]>();
	const seen = new Set<string>();
	for (let page = 1; page <= maxPages; page++) {
		const params = cleanupSearchParams(scope, { cutoff, page });
		if (!params) return empty;
		const res = await search(params);
		const groups = (res?.grouped_hits ?? []) as Array<{ group_key?: string[]; hits?: Array<{ document?: any }> }>;
		const candidates: string[] = [];
		for (const g of groups) {
			const id = String(g.hits?.[0]?.document?.threadId ?? g.group_key?.[0] ?? "");
			if (id && !seen.has(id)) {
				seen.add(id);
				candidates.push(id);
			}
		}
		if (candidates.length) {
			for (const row of await eligibleCleanupThreads(dbh, scope, { now: o.now, threadIds: candidates })) {
				const rows = byThread.get(row.threadId) ?? [];
				rows.push(row);
				byThread.set(row.threadId, rows);
			}
		}
		if (byThread.size >= limit) return { rows: [...byThread.values()].slice(0, limit).flat(), truncated: true };
		if (groups.length < params.per_page) break;
		if (page === maxPages) return { rows: [...byThread.values()].flat(), truncated: true };
	}
	return { rows: [...byThread.values()].flat(), truncated: false };
}

// Nombre de fils que la recherche stricte trouve, sans date limite (le « X fils correspondent exactement »
// du formulaire). Un compte de l'index, jamais une decision : le SQL ne passe pas ici.
export async function countStrictMatches({ search }: { search: Search }, scope: CleanupScope): Promise<number> {
	if (cleanupQueryError(scope.query)) return 0;
	const params = cleanupSearchParams(scope, { page: 1 });
	if (!params) return 0;
	const res = await search({ ...params, per_page: 1 });
	return Math.max(0, Number(res?.found) || 0);
}
