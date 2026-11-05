"use client";
// Loading screens for the mailbox routes. The interface choice is already known
// on the client (context set by the root layout): no server request is needed
// to pick between the modern skeleton and the original loading screen.
import Loading from "@/app/loading";
import { useModernUi } from "@/components/k/ui-context";
import { ListSkeleton, ReaderSkeleton } from "@/components/k/skeletons";

export function ListLoading() {
	return useModernUi() ? <ListSkeleton /> : <Loading />;
}

export function ReaderLoading() {
	return useModernUi() ? <ReaderSkeleton /> : <Loading />;
}

/** Route with no content in the classic interface (@thread/threads/[threadId]). */
export function ReaderLoadingModernOnly() {
	return useModernUi() ? <ReaderSkeleton /> : null;
}
