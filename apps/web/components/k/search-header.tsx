import React from "react";
import { and, eq } from "drizzle-orm";
import { identities, mailboxes } from "@db";
import MailboxSearch from "@/components/mailbox/default/mailbox-search";
import { getWorkspacePublicId, rlsClient } from "@/lib/actions/clients";
import { assertSignedIn } from "@/lib/authz";
import MobileNavButton from "@/components/k/mobile-nav-button";
import KCleanupSearchButton from "@/components/k/cleanup-search-button";

// ss2i (nouvelle interface) : propriete de l'identite et nature du dossier pour le bouton « Nettoyage auto... »
// (docs/plans/nettoyage-auto-recherche.md, MT12) : une seule requete legere, lue a travers RLS. Au moindre doute
// (session, identite ou dossier introuvables), pas de bouton : les actions serveur refusent de toute facon.
async function cleanupContext(identityPublicId: string, mailboxSlug: string) {
	try {
		const user = await assertSignedIn();
		const rls = await rlsClient();
		const [row] = await rls((tx) =>
			tx
				.select({ ownerId: identities.ownerId, mailboxKind: mailboxes.kind, mailboxName: mailboxes.name })
				.from(identities)
				.innerJoin(mailboxes, eq(mailboxes.identityId, identities.id))
				.where(and(eq(identities.publicId, identityPublicId), eq(mailboxes.slug, mailboxSlug)))
				.limit(1),
		);
		if (!row) return null;
		return { isOwner: row.ownerId === user.id, mailboxKind: row.mailboxKind as string | null, mailboxName: row.mailboxName as string };
	} catch {
		return null;
	}
}

// SS2i (nouvelle interface) : en-tete de la colonne liste, la recherche seule
// (le compte et les parametres sont dans la barre laterale).
export default async function KSearchHeader({ params }: { params: Promise<Record<string, string>> }) {
	const { identityPublicId, mailboxSlug } = await params;
	const workspacePublicId = await getWorkspacePublicId();
	const cleanup = await cleanupContext(identityPublicId, mailboxSlug);
	return (
		<>
			<header className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-3">
				<MobileNavButton />
				<MailboxSearch publicId={identityPublicId} mailboxSlug={mailboxSlug} workspacePublicId={workspacePublicId} nouvelle />
			</header>
			{cleanup && (
				<KCleanupSearchButton
					identityPublicId={identityPublicId}
					mailboxSlug={mailboxSlug}
					mailboxName={cleanup.mailboxName}
					mailboxKind={cleanup.mailboxKind}
					isOwner={cleanup.isOwner}
				/>
			)}
		</>
	);
}
