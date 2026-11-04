"use client";
import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, TextInput } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconBuildingPlus, IconGripVertical } from "@tabler/icons-react";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import { useK, useNouvelle } from "@/components/k/ui-context";
import { searchCrmCompanies, type CompanySearchHit } from "@/lib/actions/thread-clients";
import { endThreadDrag, linkThreadsWithUndo, startThreadDrag, useIsProIdentity } from "@/lib/client-link";

// ss2i : rattachement manuel d'un fil a un client (OI 10270), memes composants dans les deux
// interfaces : poignee de glisser sur chaque ligne de la liste (identites pro seulement), et
// fenetre « Rattacher a un client... » (barre du fil ouvert, barre de selection).

/**
 * Poignee d'une ligne : glisse le fil, ou toute la selection si la ligne en fait partie, vers
 * un client de la section Clients de la barre laterale.
 */
export function ThreadDragHandle({
	identityPublicId,
	threadId,
	subject,
	className = "",
}: {
	identityPublicId: string;
	threadId: string;
	subject: string | null | undefined;
	className?: string;
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	const pro = useIsProIdentity(identityPublicId);
	const { state } = useDynamicContext<{ selectedThreadIds: Set<string> }>();
	if (!pro) return null;
	return (
		<span
			draggable
			onDragStart={(e) => {
				e.stopPropagation();
				const sel = state?.selectedThreadIds;
				const ids = sel?.has(threadId) && sel.size > 1 ? Array.from(sel).map(String) : [threadId];
				const label =
					ids.length > 1
						? k(`${ids.length} conversations`, `${ids.length} fils`)
						: subject?.trim() || k("(no subject)", "(sans objet)");
				startThreadDrag(e, { identityPublicId, threadIds: ids, label });
			}}
			onDragEnd={endThreadDrag}
			onClick={(e) => e.stopPropagation()}
			title={k("Drag onto a client (Clients section) to link it", "Glisser sur un client (section Clients) pour le rattacher")}
			aria-label={k("Drag to link to a client", "Glisser pour rattacher à un client")}
			// ss2i : zone de prise agrandie (Samuel, 04/11 : « les deux petits points, ils sont vraiment
			// tout petits »), meme emplacement : 28 px de haut, 20 px de large, icone 18 px.
			className={`flex min-h-7 min-w-5 cursor-grab items-center justify-center rounded select-none active:cursor-grabbing hover:bg-black/5 dark:hover:bg-white/10 ${
				nouvelle ? "text-k-ink-3 hover:text-k-ink" : "text-muted-foreground hover:text-foreground"
			} ${className}`}
		>
			<IconGripVertical size={18} stroke={2.25} aria-hidden />
		</span>
	);
}

/**
 * « Rattacher a un client... » : recherche dans toute la CRM (nom, code EBP, adresse ou
 * domaine), clients recents de l'identite sans saisie ; un choix rattache les fils.
 */
export function LinkClientPicker({
	identityPublicId,
	threadIds,
	trigger,
	onLinked,
}: {
	identityPublicId: string;
	/** Lus au moment du choix (selection courante). */
	threadIds: () => string[];
	trigger: (open: () => void) => React.ReactNode;
	onLinked?: () => void;
}) {
	const k = useK();
	const nouvelle = useNouvelle();
	const router = useRouter();
	const pro = useIsProIdentity(identityPublicId);
	const [opened, { open, close }] = useDisclosure(false);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<CompanySearchHit[] | null>(null);
	const [loading, setLoading] = useState(false);
	const searching = query.trim().length >= 2;

	useEffect(() => {
		if (!opened) return;
		let alive = true;
		setLoading(true);
		const t = setTimeout(
			() => {
				searchCrmCompanies(identityPublicId, query)
					.then((r) => alive && setHits(r))
					.catch(() => alive && setHits([]))
					.finally(() => alive && setLoading(false));
			},
			searching ? 300 : 0,
		);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [opened, query, searching, identityPublicId]);

	if (!pro) return null;

	const choose = async (hit: CompanySearchHit) => {
		const ids = threadIds();
		close();
		setQuery("");
		const ok = await linkThreadsWithUndo({ identityPublicId, threadIds: ids, companyId: hit.companyId, refresh: () => router.refresh() });
		if (ok) onLinked?.();
	};

	const itemClass = nouvelle
		? "flex w-full items-center gap-2 rounded-k-sm px-2 py-1.5 text-left text-[13px] text-k-ink hover:bg-k-hover"
		: "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted";
	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";

	return (
		<>
			{trigger(open)}
			<Modal opened={opened} onClose={close} title={k("Link to a client", "Rattacher à un client")}>
				<div className="space-y-2">
					<TextInput
						data-autofocus
						value={query}
						onChange={(e) => setQuery(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && hits?.length) {
								e.preventDefault();
								void choose(hits[0]);
							}
						}}
						placeholder={k("Company name, EBP code, email address or domain", "Nom de la société, code EBP, adresse mail ou domaine")}
						aria-label={k("Search the CRM", "Rechercher dans la CRM")}
					/>
					<div className={`text-xs ${muted}`}>
						{loading
							? k("Searching…", "Recherche…")
							: searching
								? k("Companies of the CRM", "Sociétés de la CRM")
								: k("Recent clients of this mailbox", "Clients récents de cette boîte")}
					</div>
					<ul className="max-h-80 space-y-px overflow-y-auto">
						{(hits ?? []).map((h) => (
							<li key={h.companyId}>
								<button type="button" className={itemClass} onClick={() => void choose(h)}>
									<span className="min-w-0 flex-1 truncate font-medium">{h.name}</span>
									{h.ebpCustomerId && <span className={`shrink-0 text-xs ${muted}`}>{h.ebpCustomerId}</span>}
									<span className={`shrink-0 text-xs ${muted}`}>
										{h.threadCount > 0
											? k(`${h.threadCount} conv.`, `${h.threadCount} fil${h.threadCount > 1 ? "s" : ""}`)
											: k("no thread yet", "aucun fil")}
									</span>
								</button>
							</li>
						))}
					</ul>
					{!loading && hits && hits.length === 0 && (
						<div className={`py-2 text-sm ${muted}`}>
							{searching
								? k("No company found in the CRM.", "Aucune société trouvée dans la CRM.")
								: k("Type a name, an email address or a domain.", "Tapez un nom, une adresse mail ou un domaine.")}
						</div>
					)}
				</div>
			</Modal>
		</>
	);
}

/** « Rattacher a un client... » pour un fil ouvert (composant serveur de l'interface classique). */
export function LinkThreadToClientButton({ identityPublicId, threadId }: { identityPublicId: string; threadId: string }) {
	const k = useK();
	return (
		<LinkClientPicker
			identityPublicId={identityPublicId}
			threadIds={() => [threadId]}
			trigger={(open) => (
				<button
					type="button"
					onClick={open}
					className="inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:border-solid hover:text-foreground"
					title={k("Link this conversation to a client of the CRM", "Rattacher ce fil à un client de la CRM")}
				>
					<IconBuildingPlus size={14} aria-hidden />
					{k("Link to a client…", "Rattacher à un client…")}
				</button>
			)}
		/>
	);
}
