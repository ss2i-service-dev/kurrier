// Classic interface: the folder list under an open thread. Pure logic (tested in
// test/list-under-thread.ts), shared by the server action, the ListSlot component and the
// settings.

export type ListUnderThread = "hidden" | "shown";

// Shown by default (original behaviour): any unknown or missing value gives "shown".
export function parseListUnderThread(value: unknown): ListUnderThread {
	return value === "hidden" ? "hidden" : "shown";
}

// Same path test as ThreadSlot: the path, not useParams.
export function pathHasThread(pathname: string | null | undefined): boolean {
	return /\/threads\/[^/]+/.test(pathname ?? "");
}

export function listIsHidden(mode: ListUnderThread, pathname: string | null | undefined): boolean {
	return mode === "hidden" && pathHasThread(pathname);
}
