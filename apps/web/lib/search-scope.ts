// ss2i : filtres Typesense de la recherche du webmail, dossier courant ou tous les dossiers
// (Samuel le 06/11/2026 : depuis l'Inbox on cherche dans l'Inbox, et si rien ne sort la modale
// propose d'etendre la recherche). Logique pure, testee par apps/web/test/search-all-folders.ts.

// Dossiers jamais couverts par la recherche etendue : ce qu'on a jete, le spam, et la file
// d'envoi interne.
export const SEARCH_EXCLUDED_KINDS = ["trash", "spam", "outbox"];

// Un slug (encodeURIComponent ou slugify) ne contient jamais ces caracteres, qui permettraient
// de sortir de la valeur du filtre Typesense.
const UNSAFE = /["`\\&|\[\],]/;

export type SearchScopeInput = {
	workspacePublicId: string;
	identityPublicId: string;
	// null = tous les dossiers de l'identite, sauf excludeSlugs
	mailboxSlug: string | null;
	excludeSlugs?: string[];
	hasAttachment?: boolean;
	onlyUnread?: boolean;
	starred?: boolean;
};

export function searchFilters(i: SearchScopeInput): string[] | null {
	const filters = [
		`workspacePublicId:=${JSON.stringify(i.workspacePublicId)}`,
		`identityPublicId:=${JSON.stringify(i.identityPublicId)}`,
	];
	if (i.mailboxSlug !== null) {
		const slug = String(i.mailboxSlug ?? "");
		if (UNSAFE.test(slug)) return null;
		filters.push(`mailboxSlug:=${JSON.stringify(slug)}`);
	} else {
		const excluded = (i.excludeSlugs ?? []).filter(Boolean).map(String);
		if (excluded.some((s) => UNSAFE.test(s))) return null;
		if (excluded.length) filters.push(`mailboxSlug:!=[${excluded.map((s) => `\`${s}\``).join(",")}]`);
	}
	if (i.hasAttachment) filters.push("hasAttachment:=1");
	if (i.onlyUnread) filters.push("unread:=1");
	if (i.starred) filters.push("starred:=1");
	return filters;
}
