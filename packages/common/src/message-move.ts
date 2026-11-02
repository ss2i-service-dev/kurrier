// ss2i : deplacement au grain du message (blocage d'expediteur). Un fil peut melanger des
// messages de l'expediteur bloque et d'autres : seuls les premiers partent. Fonction pure,
// partagee par le worker (moveMail) et testee sans base.

// `source` : tous les messages des fils concernes qui sont dans le dossier source ;
// `onlyIds` : les messages a deplacer. Rend ceux a deplacer (presents dans le dossier source),
// les fils entierement deplaces (plus aucun message dans la source) et les fils partiels.
export function planMessageMove(
	source: Array<{ id: string; threadId: string }>,
	onlyIds: Iterable<string>,
) {
	const only = new Set(onlyIds);
	const moving = source.filter((m) => only.has(m.id));
	const movingThreads = new Set(moving.map((m) => m.threadId));
	const staying = new Set(source.filter((m) => !only.has(m.id)).map((m) => m.threadId));
	const fullThreadIds: string[] = [];
	const partialThreadIds: string[] = [];
	for (const t of movingThreads) (staying.has(t) ? partialThreadIds : fullThreadIds).push(t);
	return { messageIds: moving.map((m) => m.id), fullThreadIds, partialThreadIds };
}
