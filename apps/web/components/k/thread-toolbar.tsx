"use client";
// SS2i : barre d'actions du fil ouvert. Tout est optimiste : l'action part en
// arriere-plan et on passe aussitot au fil suivant (ou a la liste).
import React, { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Archive, ArrowLeft, ChevronDown, ChevronUp, Mail, Trash2, X } from "lucide-react";
import KIconButton from "@/components/k/icon-button";
import SnoozeMail from "@/components/k/snooze";
import { IconPin, IconPinnedOff } from "@tabler/icons-react";
import { isManuallyUnread, isMarkedRead, mailActions, useMailStore } from "@/components/k/mail-store";

/** Lignes de la liste visibles, dans l'ordre affiche. */
function rows(): HTMLElement[] {
	return Array.from(document.querySelectorAll<HTMLElement>("li[data-thread-id]")).filter((el) => el.offsetParent !== null);
}

export default function ThreadToolbar({
	threadId,
	activeMailboxId,
	activeMailboxKind,
	markSmtp,
	hasUnread,
	pinned: serverPinned = false,
}: {
	threadId: string;
	activeMailboxId: string;
	activeMailboxKind: string;
	markSmtp: boolean;
	hasUnread: boolean;
	pinned?: boolean;
}) {
	const pinOverride = useMailStore((s) => s.pinned.get(String(threadId)));
	const pinned = pinOverride ?? serverPinned;
	const router = useRouter();
	const pathname = usePathname() ?? "";
	const listUrl = pathname.replace(/\/threads\/[^/]+\/?$/, "");
	// Fermer le fil : la liste est deja affichee, inutile de la redemander au
	// serveur. Un pushState natif suffit (Next le synchronise avec usePathname,
	// et le panneau de lecture se masque d'apres le chemin).
	const close = () => window.history.pushState(null, "", listUrl);

	// Ouvrir un fil le marque lu : tout de suite a l'ecran, en arriere-plan au serveur.
	const marked = useRef<string | null>(null);
	useEffect(() => {
		if (!hasUnread || marked.current === threadId) return;
		marked.current = threadId;
		// remis en non lu a la main : on le laisse non lu (le panneau peut etre
		// redessine apres l'actualisation qui suit l'action)
		if (isManuallyUnread(threadId)) return;
		// deja fait au clic dans la liste (ouverture depuis la liste)
		if (isMarkedRead(threadId)) return;
		mailActions.read(threadId, activeMailboxId, markSmtp, 1);
	}, [threadId, hasUnread, activeMailboxId, markSmtp]);

	const neighbour = (step: 1 | -1) => {
		const list = rows();
		const i = list.findIndex((el) => el.dataset.threadId === threadId);
		if (i < 0) return null;
		return list[i + step] ?? null;
	};
	const go = (step: 1 | -1) => {
		const el = neighbour(step);
		if (el) {
			el.click();
			el.scrollIntoView({ block: "nearest" });
		}
	};
	// Apres archivage/suppression : fil suivant, sinon precedent, sinon la liste.
	const advance = () => {
		const el = neighbour(1) ?? neighbour(-1);
		if (el) el.click();
		else close();
	};

	const archive = () => {
		advance();
		mailActions.archive(threadId, activeMailboxId, markSmtp);
	};
	const trash = () => {
		advance();
		mailActions.trash(threadId, activeMailboxId, markSmtp, activeMailboxKind === "trash");
	};
	const unread = () => {
		mailActions.unread(threadId, activeMailboxId, markSmtp, 1);
		close();
	};

	return (
		<div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-k-line px-2">
			<KIconButton label="Fermer" shortcut="Échap" action="close" onClick={close}>
				<ArrowLeft className="lg:hidden" />
				<X className="hidden lg:block" />
			</KIconButton>
			<span className="mx-1.5 h-5 w-px bg-k-line" />
			{activeMailboxKind !== "archive" && (
				<KIconButton label="Archiver" shortcut="A" action="archive" onClick={archive}>
					<Archive />
				</KIconButton>
			)}
			<KIconButton
				label={activeMailboxKind === "trash" ? "Supprimer définitivement" : "Supprimer"}
				shortcut="E"
				tone="danger"
				action="delete"
				onClick={trash}
			>
				<Trash2 />
			</KIconButton>
			<KIconButton label="Marquer comme non lu" shortcut="U" action="unread" onClick={unread}>
				<Mail />
			</KIconButton>
			<SnoozeMail mailboxThreadId={threadId} activeMailboxId={activeMailboxId} />
			<KIconButton
				label={pinned ? "Désépingler" : "Épingler en haut du dossier"}
				onClick={() => mailActions.pin(threadId, !pinned)}
				className={pinned ? "text-k-accent" : undefined}
			>
				{pinned ? <IconPinnedOff /> : <IconPin />}
			</KIconButton>

			<div className="ml-auto flex items-center">
				<KIconButton label="Fil précédent" shortcut="K" onClick={() => go(-1)}>
					<ChevronUp />
				</KIconButton>
				<KIconButton label="Fil suivant" shortcut="J" onClick={() => go(1)}>
					<ChevronDown />
				</KIconButton>
			</div>
		</div>
	);
}
