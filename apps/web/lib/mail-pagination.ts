// Number of pages of a folder list. Pure, tested by test/mail-pagination.ts.
/** Whole number of pages for `total` threads of `size` per page, at least one (next arrow greyed out). */
export function pageCount(total: number, size: number): number {
	const n = Number.isFinite(total) && total > 0 ? total : 0;
	return Math.max(1, Math.ceil(n / size));
}

/** Page brought back between 1 and `pages`. */
export function clampPage(page: number, pages: number): number {
	const p = Number.isFinite(page) ? Math.trunc(page) : 1;
	return Math.min(Math.max(1, p), Math.max(1, pages));
}
