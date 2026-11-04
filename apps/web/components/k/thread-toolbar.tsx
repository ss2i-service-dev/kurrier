"use client";
// SS2i : barre d'actions du fil ouvert. Tout est optimiste : l'action part en
// arriere-plan et on passe aussitot au fil suivant (ou a la liste).
import React, { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Archive, ArrowLeft, Building2, ChevronDown, ChevronUp, ClipboardList, Mail, Trash2, X } from "lucide-react";
import { LinkClientPicker } from "@/components/mailbox/default/client-link-ui";
import { copyMailToClipboard } from "@/lib/mail-copy";
import KIconButton from "@/components/k/icon-button";
import SnoozeMail from "@/components/k/snooze";
import { IconPin, IconPinnedOff } from "@tabler/icons-react";
import { useShortcutHint } from "@/components/k/shortcuts-config";
import { isManuallyUnread, isMarkedRead, mailActions, setActiveThread, setClosingThread, useMailStore } from "@/components/k/mail-store";

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
	identityPublicId,
}: {
	threadId: string;
	activeMailboxId: string;
	activeMailboxKind: string;
	markSmtp: boolean;
	hasUnread: boolean;
	pinned?: boolean;
	/** ss2i (OI 10270) : « Rattacher a un client... » (identites pro). */
	identityPublicId?: string;
}) {
	const pinOverride = useMailStore((s) => s.pinned.get(String(threadId)));
	const pinned = pinOverride ?? serverPinned;
	const router = useRouter();
	const pathname = usePathname() ?? "";
	const listUrl = pathname.replace(/\/threads\/[^/]+\/?$/, "");
	// Fermer le fil : vraie navigation vers la liste (le routeur de Next doit
	// savoir que le fil est ferme, sinon l'actualisation suivante, apres lu / non
	// lu..., ne correspond plus et recharge toute la page). Le panneau de lecture
	// se masque tout de suite, sans attendre la reponse.
	const close = () => {
		setClosingThread(threadId);
		setActiveThread(null);
		router.push(listUrl, { scroll: false });
	};

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

	// Touches affichees dans les infobulles : celles de l'utilisateur (Parametres).
	const hint = {
		close: useShortcutHint("close"),
		archive: useShortcutHint("archive"),
		delete: useShortcutHint("delete"),
		unread: useShortcutHint("unread"),
		prev: useShortcutHint("prev"),
		next: useShortcutHint("next"),
	};

	return (
		<div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-k-line px-2">
			<KIconButton label="Fermer" shortcut={hint.close} action="close" onClick={close}>
				<ArrowLeft className="lg:hidden" />
				<X className="hidden lg:block" />
			</KIconButton>
			<span className="mx-1.5 h-5 w-px bg-k-line" />
			{activeMailboxKind !== "archive" && (
				<KIconButton label="Archiver" shortcut={hint.archive} action="archive" onClick={archive}>
					<Archive />
				</KIconButton>
			)}
			<KIconButton
				label={activeMailboxKind === "trash" ? "Supprimer définitivement" : "Supprimer"}
				shortcut={hint.delete}
				tone="danger"
				action="delete"
				onClick={trash}
			>
				<Trash2 />
			</KIconButton>
			<KIconButton label="Marquer comme non lu" shortcut={hint.unread} action="unread" onClick={unread}>
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
			<KIconButton label="Copier tout le fil (pour un agent IA)" onClick={() => copyMailToClipboard({ threadId: String(threadId) })}>
				<ClipboardList />
			</KIconButton>
			{identityPublicId && (
				<LinkClientPicker
					identityPublicId={identityPublicId}
					threadIds={() => [String(threadId)]}
					trigger={(open) => (
						<KIconButton label="Rattacher à un client…" onClick={open}>
							<Building2 />
						</KIconButton>
					)}
				/>
			)}

			<div className="ml-auto flex items-center">
				<KIconButton label="Fil précédent" shortcut={hint.prev} onClick={() => go(-1)}>
					<ChevronUp />
				</KIconButton>
				<KIconButton label="Fil suivant" shortcut={hint.next} onClick={() => go(1)}>
					<ChevronDown />
				</KIconButton>
			</div>
		</div>
	);
}
