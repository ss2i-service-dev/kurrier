"use client";
// ss2i : bouton « Nettoyage auto... » de la recherche de la nouvelle interface (docs/plans/nettoyage-auto-recherche.md,
// MT12). Rendu par KSearchHeader, il ne s'affiche que sur la page de resultats (.../search?q=...) et lit la
// recherche dans l'URL, comme la page : texte, filtres pieces jointes et non lus. Les resultats couvrent le
// dossier courant (la recherche « tous les dossiers » reste dans la modale de MailboxSearch), donc allFolders
// vaut false. Le filtre « etoile » ne sert qu'a desactiver le bouton : il n'est jamais transmis au formulaire.
import React from "react";
import { Button, Modal } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Eraser } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import KCleanupRule from "@/components/k/cleanup-rule-form";
import { cleanupButtonState } from "@/lib/cleanup-search-button";

export default function KCleanupSearchButton({
	identityPublicId,
	mailboxSlug,
	mailboxName,
	mailboxKind,
	isOwner,
}: {
	identityPublicId: string;
	mailboxSlug: string;
	mailboxName: string;
	mailboxKind: string | null;
	isOwner: boolean;
}) {
	const pathname = usePathname();
	const sp = useSearchParams();
	const [opened, { open, close }] = useDisclosure(false);
	if (!/\/search\/?$/.test(pathname ?? "")) return null;

	const query = sp.get("q") ?? "";
	const hasAttachment = sp.get("has") === "1";
	const onlyUnread = sp.get("unread") === "1";
	const starred = sp.get("starred") === "1";
	const allFolders = false;
	const state = cleanupButtonState({ isOwner, query, starred, mailboxKind, allFolders });
	if (!state.show) return null;

	return (
		<div className="flex flex-col items-start gap-1 px-3 pb-1">
			<Button
				size="xs"
				variant="default"
				leftSection={<Eraser size={14} />}
				data-k-action="cleanup-rule"
				disabled={Boolean(state.disabledReason)}
				onClick={open}
			>
				Nettoyage auto...
			</Button>
			{state.disabledReason && <p className="text-[12px] text-k-ink-3">{state.disabledReason}</p>}
			<Modal
				centered
				opened={opened}
				onClose={close}
				title={<span className="text-[15px] font-semibold">Nettoyage automatique</span>}
				size="md"
				zIndex={1003}
			>
				<KCleanupRule
					identityPublicId={identityPublicId}
					mailboxSlug={mailboxSlug}
					mailboxName={mailboxName}
					allFolders={allFolders}
					query={query}
					hasAttachment={hasAttachment}
					onlyUnread={onlyUnread}
					onDone={close}
				/>
			</Modal>
		</div>
	);
}
