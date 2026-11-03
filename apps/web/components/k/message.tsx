// @ts-nocheck
"use client";
// SS2i (nouvelle interface) : un message du fil, mise en page a plat. Replie : une ligne
// (expediteur, extrait, date). Deplie : en-tete, corps, pieces jointes.
// La reponse ne s'ouvre plus ici mais dans la zone ancree en bas du panneau
// (components/k/reply-dock.tsx), via le contexte du fil.
import React, { useEffect, useMemo, useState } from "react";
import { MessageAttachmentEntity, MessageEntity } from "@db";
import { getMessageAddress, getMessageName } from "@common/mail-client";
import { Ban, ChevronUp, Code, Download, EllipsisVertical, Forward, Paperclip, Reply, ReplyAll } from "lucide-react";
import { useExpandSignal } from "@/components/k/thread-messages";
import { Menu, Modal } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { PublicConfig } from "@schema";
import KAvatar from "@/components/k/avatar";
import KIconButton from "@/components/k/icon-button";
import { fullDate, listDate, relativeDate } from "@/components/k/format";
import { useThread } from "@/components/k/thread-context";
import KAttachments from "@/components/k/attachments";
import BlockSenderModal from "@/components/mailbox/default/block-sender-modal";
import { emailDomain, isFreeMailDomain, normalizeAddress } from "@common/sender-block";
import { FetchIdentityMailboxListResult, FetchThreadMailSubsResult } from "@/lib/actions/mailbox";
import { replyRecipients } from "@/lib/reply-recipients";
import { getRawMessageDownloadUrl } from "@/lib/actions/uploads-actions";

import type { MessageAttachmentWithUrl } from "@/components/mailbox/default/email-renderer";

type Addr = { name?: string | null; address?: string | null };

function addrList(message: MessageEntity, f: "from" | "to" | "cc" | "bcc"): Addr[] {
	const v = (message as any)[f];
	if (!v) return [];
	if (typeof v === "string") return [{ name: null, address: v }];
	return Array.isArray(v.value) ? v.value : [];
}

function KMessage({
	threadIndex,
	numberOfMessages,
	message,
	attachments,
	inlineShownIds = [],
	publicConfig,
	identityMailboxes,
	children,
	defaultExpanded = true,
	invite = null,
}: {
	threadIndex: number;
	numberOfMessages: number;
	message: MessageEntity;
	attachments: MessageAttachmentWithUrl[];
	inlineShownIds?: string[];
	publicConfig: PublicConfig;
	threadId?: string;
	markSmtp?: boolean;
	activeMailboxId?: string;
	mailSubscription?: FetchThreadMailSubsResult["byMessageId"] | null;
	identityMailboxes: FetchIdentityMailboxListResult;
	children?: React.ReactNode;
	defaultExpanded?: boolean;
	invite?: React.ReactNode;
}) {
	const { register, openReply } = useThread();
	useEffect(() => register(message), [message, register]);

	const isLast = threadIndex === numberOfMessages - 1;
	const [expanded, setExpanded] = useState<boolean>(defaultExpanded || isLast);
	const [showDetails, setShowDetails] = useState(false);
	// « Tout deplier / Tout replier » (au-dessus des messages).
	const signal = useExpandSignal();
	useEffect(() => {
		if (signal) setExpanded(signal.mode === "expand");
	}, [signal]);
	// Clic sur l'en-tete d'un message deplie : on le replie, sauf sur un bouton,
	// un lien, ou une selection de texte en cours.
	const onHeaderClick = (e: React.MouseEvent) => {
		const t = e.target as HTMLElement;
		if (t.closest("button, a, input, [role='menu'], [role='menuitem']")) return;
		if (window.getSelection()?.toString()) return;
		setExpanded(false);
	};

	const own = useMemo(
		() => (identityMailboxes ?? []).map((im) => String(im.identity.value)),
		[identityMailboxes],
	);
	const ownSet = useMemo(() => new Set(own.map((e) => e.toLowerCase())), [own]);
	const hasOtherRecipients = useMemo(() => replyRecipients(message, own).cc.length > 0, [message, own]);
	const defaultReplyMode = hasOtherRecipients ? "replyAll" : "reply";

	const fromEmail = getMessageAddress(message, "from") || "";
	const fromName = getMessageName(message, "from") || fromEmail;
	const fromMe = ownSet.has(fromEmail.toLowerCase());
	const who = (a: Addr) => (a.address && ownSet.has(a.address.toLowerCase()) ? "moi" : a.name || a.address || "");
	const to = addrList(message, "to");
	const cc = addrList(message, "cc");
	const toLine = [...to, ...cc].map(who).filter(Boolean);
	// Pieces jointes reelles (les images affichees dans le corps, signatures
	// comprises, ne comptent pas).
	const realFiles = (attachments ?? []).filter((a) => !inlineShownIds.includes(a.id)).length;
	const snippet = String(message.snippet ?? message.text ?? "").replace(/\s+/g, " ").slice(0, 200);

	// Blocage de l'expediteur (meme regles que la classique : pas les domaines grand public).
	const senderAddress = normalizeAddress(fromEmail);
	const senderDomain = emailDomain(senderAddress);
	const [blockTarget, setBlockTarget] = useState<{ kind: "address" | "domain"; value: string } | null>(null);

	// Message original (en-tetes + source brute)
	const [opened, { open, close }] = useDisclosure(false);
	const [raw, setRaw] = useState<string | null>(null);
	useEffect(() => {
		if (!opened) return;
		getRawMessageDownloadUrl(message.id).then(({ url }) => {
			if (!url) return;
			fetch(url)
				.then((res) => res.text())
				.then((t) => setRaw(t.slice(0, 10000)));
		});
	}, [opened, message.id]);
	const downloadEml = async () => {
		const { url } = await getRawMessageDownloadUrl(message.id);
		if (url) window.open(url, "_blank");
	};

	if (!expanded) {
		return (
			<button
				type="button"
				onClick={() => setExpanded(true)}
				aria-expanded={false}
				className="k-msg-card group/msg flex w-full items-center gap-3 rounded-k-pane border border-k-line bg-k-surface px-4 py-2.5 text-left transition-colors hover:border-k-line-strong hover:bg-k-surface-2"
			>
				<KAvatar name={fromName} email={fromEmail} size={28} />
				<span className="w-36 shrink-0 truncate text-[13.5px] font-medium text-k-ink sm:w-44">
					{fromMe ? "Moi" : fromName}
				</span>
				<span className="min-w-0 flex-1 truncate text-[13px] text-k-ink-3">{snippet}</span>
				{realFiles > 0 && <Paperclip className="h-3.5 w-3.5 shrink-0 text-k-ink-3" />}
				<time className="shrink-0 text-[12px] tabular-nums text-k-ink-3" title={fullDate(message.createdAt)}>
					{listDate(message.createdAt)}
				</time>
			</button>
		);
	}

	const detailRow = (label: string, list: Addr[]) =>
		list.length > 0 && (
			<div className="flex gap-2">
				<span className="w-8 shrink-0 text-k-ink-3">{label}</span>
				<span className="min-w-0 text-k-ink-2">
					{list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ")}
				</span>
			</div>
		);

	return (
		<article aria-expanded className="k-msg-card group/msg rounded-k-pane border border-k-line bg-k-surface shadow-k-pane">
			<Modal opened={opened} onClose={close} title="Message original" size="xl">
				<div className="overflow-hidden rounded-k border border-k-line text-[13px]">
					{[
						["Message-ID", message.messageId],
						["Date", fullDate(message.createdAt)],
						["De", String(message?.headersJson?.from?.text ?? "")],
						["À", message?.headersJson?.to?.text ? String(message.headersJson.to.text) : "destinataires non divulgués"],
						["Objet", message?.headersJson?.subject],
					].map(([k, v]) => (
						<div key={k} className="grid grid-cols-[130px_1fr] border-b border-k-line last:border-0">
							<div className="bg-k-surface-2 px-3 py-2 font-medium text-k-ink-3">{k}</div>
							<div className="break-all px-3 py-2 text-k-ink">{v}</div>
						</div>
					))}
				</div>
				<pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-k bg-k-surface-2 p-4 font-mono text-[12px] text-k-ink-2">
					{raw || "Chargement du message brut…"}
				</pre>
			</Modal>

			{blockTarget && (
				<BlockSenderModal kind={blockTarget.kind} value={blockTarget.value} opened onClose={() => setBlockTarget(null)} />
			)}

			{/* En-tete */}
			<header
				onClick={onHeaderClick}
				title="Cliquer pour replier"
				className="flex cursor-pointer items-start gap-3 rounded-t-k-pane px-4 pb-3 pt-3.5 transition-colors hover:bg-k-surface-2/60"
			>
				<KAvatar name={fromName} email={fromEmail} size={34} />
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span className="truncate text-[14px] font-semibold text-k-ink">{fromMe ? "Moi" : fromName}</span>
						{fromEmail && !fromMe && fromEmail !== fromName && (
							<span className="hidden truncate text-[12.5px] text-k-ink-3 sm:inline">{fromEmail}</span>
						)}
					</div>
					<button
						type="button"
						onClick={() => setShowDetails((v) => !v)}
						className="max-w-full truncate text-left text-[12.5px] text-k-ink-3 hover:text-k-ink-2"
					>
						à {toLine.length ? toLine.join(", ") : "destinataires non divulgués"}
						<span className="ml-1 text-[10px]">{showDetails ? "▲" : "▼"}</span>
					</button>
					{showDetails && (
						<div className="mt-2 space-y-1 rounded-k-sm bg-k-surface-2 px-3 py-2 text-[12.5px]">
							{detailRow("De", [{ name: getMessageName(message, "from"), address: fromEmail }])}
							{detailRow("À", to)}
							{detailRow("Cc", cc)}
							<div className="flex gap-2">
								<span className="w-8 shrink-0 text-k-ink-3">Le</span>
								<span className="text-k-ink-2">{fullDate(message.createdAt)}</span>
							</div>
						</div>
					)}
				</div>

				<div className="flex shrink-0 items-center gap-0.5">
					<time
						className="mr-1 whitespace-nowrap text-[12px] tabular-nums text-k-ink-3"
						title={fullDate(message.createdAt)}
					>
						{relativeDate(message.createdAt)}
					</time>
					<div className="flex items-center opacity-100 transition-opacity md:opacity-0 md:group-hover/msg:opacity-100 md:group-focus-within/msg:opacity-100">
						<KIconButton
							size="sm"
							label={hasOtherRecipients ? "Répondre à tous" : "Répondre"}
							onClick={() => openReply(message.id, defaultReplyMode)}
						>
							{hasOtherRecipients ? <ReplyAll /> : <Reply />}
						</KIconButton>
						<KIconButton size="sm" label="Transférer" onClick={() => openReply(message.id, "forward")}>
							<Forward />
						</KIconButton>
						<Menu shadow="none" width={220} position="bottom-end" radius={12}>
							<Menu.Target>
								<KIconButton size="sm" label="Plus">
									<EllipsisVertical />
								</KIconButton>
							</Menu.Target>
							<Menu.Dropdown className="!border-0 shadow-k-pop">
								<Menu.Item leftSection={<Reply size={15} />} onClick={() => openReply(message.id, "reply")}>
									Répondre à l'expéditeur
								</Menu.Item>
								{hasOtherRecipients && (
									<Menu.Item leftSection={<ReplyAll size={15} />} onClick={() => openReply(message.id, "replyAll")}>
										Répondre à tous
									</Menu.Item>
								)}
								<Menu.Item leftSection={<Forward size={15} />} onClick={() => openReply(message.id, "forward")}>
									Transférer
								</Menu.Item>
								{senderAddress.includes("@") && !fromMe && (
									<>
										<Menu.Divider />
										<Menu.Item color="red" leftSection={<Ban size={15} />} onClick={() => setBlockTarget({ kind: "address", value: senderAddress })}>
											Bloquer {senderAddress}
										</Menu.Item>
										{senderDomain && !isFreeMailDomain(senderDomain) && (
											<Menu.Item color="red" leftSection={<Ban size={15} />} onClick={() => setBlockTarget({ kind: "domain", value: senderDomain })}>
												Bloquer le domaine {senderDomain}
											</Menu.Item>
										)}
									</>
								)}
								<Menu.Divider />
								<Menu.Item leftSection={<Download size={15} />} onClick={downloadEml}>
									Télécharger (.eml)
								</Menu.Item>
								<Menu.Item leftSection={<Code size={15} />} onClick={open}>
									Afficher l'original
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					</div>
					<KIconButton size="sm" label="Replier" onClick={() => setExpanded(false)}>
						<ChevronUp />
					</KIconButton>
				</div>
			</header>

			{/* Corps */}
			<div className="border-t border-k-line px-4 pb-4 pt-4">
				{invite}
				{children}

				<KAttachments attachments={attachments} hiddenIds={inlineShownIds} />
			</div>
		</article>
	);
}

export default KMessage;
