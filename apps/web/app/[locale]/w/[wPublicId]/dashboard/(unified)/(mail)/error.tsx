"use client";

// An error in the mail area must not leave the user on Next's "This page couldn't load"
// screen, which neither Back nor reload gets out of. Offer to retry, to go back to the
// inbox of the identity in the URL, or to the mail home.
import React from "react";
import { usePathname } from "next/navigation";

export default function MailError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const pathname = usePathname() ?? "";

	React.useEffect(() => {
		console.error("[mail] page error", error?.digest, error);
	}, [error]);

	// /<locale>/w/<ws>/dashboard/mail/<identity>/... -> inbox of this identity.
	const m = pathname.match(/^(.*\/w\/[^/]+\/dashboard\/mail)(?:\/([^/]+))?/);
	const mailRoot = m?.[1] ?? "/";
	const identity = m?.[2];
	const inboxHref = identity ? `${mailRoot}/${identity}/inbox` : mailRoot;

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
			<h2 className="text-lg font-semibold">This page could not be displayed</h2>
			<p className="max-w-md text-sm opacity-70">
				The rest of the mail app is working. Go back to the inbox or try again.
				{error?.digest ? ` (reference ${error.digest})` : ""}
			</p>
			<div className="flex gap-2">
				<a
					href={inboxHref}
					className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
				>
					Inbox
				</a>
				<button
					type="button"
					onClick={() => reset()}
					className="rounded-md border px-4 py-2 text-sm"
				>
					Try again
				</button>
			</div>
		</div>
	);
}
