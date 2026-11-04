"use client";

// ss2i : une erreur dans la messagerie ne laisse plus sur l'ecran « This page couldn't load »
// de Next, dont ni Precedent ni F5 ne sortaient (Samuel, 04/11/2026 : « il faut pas qu'une url
// soit bloquante comme ca »). On propose de reessayer, de revenir a l'Inbox de l'identite de
// l'URL, ou a l'accueil de la messagerie.
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
		console.error("[courrier] erreur de page", error?.digest, error);
	}, [error]);

	// /<locale>/w/<ws>/dashboard/mail/<identite>/... -> Inbox de cette identite.
	const m = pathname.match(/^(.*\/w\/[^/]+\/dashboard\/mail)(?:\/([^/]+))?/);
	const mailRoot = m?.[1] ?? "/";
	const identity = m?.[2];
	const inboxHref = identity ? `${mailRoot}/${identity}/inbox` : mailRoot;

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
			<h2 className="text-lg font-semibold">Cette page n'a pas pu s'afficher</h2>
			<p className="max-w-md text-sm opacity-70">
				Le reste de la messagerie fonctionne. Reviens à la boîte de réception ou réessaie.
				{error?.digest ? ` (référence ${error.digest})` : ""}
			</p>
			<div className="flex gap-2">
				<a
					href={inboxHref}
					className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
				>
					Boîte de réception
				</a>
				<button
					type="button"
					onClick={() => reset()}
					className="rounded-md border px-4 py-2 text-sm"
				>
					Réessayer
				</button>
			</div>
		</div>
	);
}
