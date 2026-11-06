// ss2i : nombre de pages de la liste d'un dossier (Samuel le 06/11 : les fleches de
// pagination ne faisaient rien). Pur, teste par test/mail-pagination.ts.
/** Nombre de pages entier pour `total` fils de `size` par page, au moins une (fleche suivante grisee). */
export function pageCount(total: number, size: number): number {
	const n = Number.isFinite(total) && total > 0 ? total : 0;
	return Math.max(1, Math.ceil(n / size));
}

/** Page ramenee entre 1 et `pages`. */
export function clampPage(page: number, pages: number): number {
	const p = Number.isFinite(page) ? Math.trunc(page) : 1;
	return Math.min(Math.max(1, p), Math.max(1, pages));
}
