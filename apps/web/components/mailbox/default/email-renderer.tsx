// @ts-nocheck
"use client";
import { useStripSubjectPrefixes } from "@/components/mailbox/default/compose-style-context";
import { subjectForDisplay } from "@common/subject";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { leaveThreadToList } from "@/lib/leave-thread";
import { MessageAttachmentEntity, MessageEntity } from "@db";
import { getMessageAddress, getMessageName } from "@common/mail-client";
import slugify from "@sindresorhus/slugify";
import { Archive, Ban, ClipboardCopy, ClipboardList, Code, Download, EllipsisVertical, Forward, Mail, Reply, ReplyAll, Trash2 } from "lucide-react";
import { copyMailToClipboard } from "@/lib/mail-copy";
import { Temporal } from "@js-temporal/polyfill";
import dynamic from "next/dynamic";
import { ActionIcon, Button, Menu, Modal, Tooltip } from "@mantine/core";
import { EmailEditorHandle } from "@/components/mailbox/default/editor/email-editor";
import MessageAttachments from "@/components/mailbox/default/message-attachments";
import { PublicConfig } from "@schema";
import {archiveThread, fetchMailbox, FetchIdentityMailboxListResult, FetchThreadMailSubsResult, markAsRead, markAsUnread, moveToTrash} from "@/lib/actions/mailbox";
import { replyRecipients } from "@/lib/reply-recipients";
import { toast } from "sonner";
import { moveWithUndo } from "@/lib/pending-moves";
import {getRawMessageDownloadUrl} from "@/lib/actions/uploads-actions";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useDisclosure } from "@mantine/hooks";
import MailUnsubscriber from "@/components/mailbox/default/mail-unsubscriber";
import BlockSenderModal from "@/components/mailbox/default/block-sender-modal";
import { emailDomain, isFreeMailDomain, normalizeAddress } from "@common/sender-block";
const EmailEditor = dynamic(
	() => import("@/components/mailbox/default/editor/email-editor"),
	{
		ssr: false,
		loading: () => (
			<div className="py-10 text-sm text-muted-foreground">Loading editor…</div>
		),
	},
);
export type MessageAttachmentWithUrl = MessageAttachmentEntity & {
	signedUrl: string;
	// URL signed with Content-Disposition attachment (direct download).
	downloadUrl?: string;
};

function getScrollParent(el: HTMLElement): HTMLElement {
	let p: HTMLElement | null = el.parentElement;
	while (p) {
		const s = getComputedStyle(p);
		const overflowY = s.overflowY || s.overflow;
		const canScrollY =
			(overflowY === "auto" || overflowY === "scroll") &&
			p.scrollHeight > p.clientHeight;
		if (canScrollY) return p;
		p = p.parentElement;
	}
	return (document.scrollingElement || document.documentElement) as HTMLElement;
}

export function scrollToEditor(
	el: HTMLElement,
	{ offsetTop = 96, minBottomGap = 48 } = {},
) {
	const container = getScrollParent(el);
	const isWindow = container === (document.scrollingElement as HTMLElement);

	const cRect = isWindow
		? ({ top: 10, height: window.innerHeight } as any)
		: container.getBoundingClientRect();
	const eRect = el.getBoundingClientRect();
	const currentTop = isWindow ? window.scrollY : container.scrollTop;

	// Place the editor top just below the sticky header
	const targetTop = currentTop + (eRect.top - cRect.top) - offsetTop;

	const doScroll = (top: number) => {
		if (isWindow) window.scrollTo({ top, behavior: "smooth" });
		else container.scrollTo({ top, behavior: "smooth" });
	};

	doScroll(targetTop);

	setTimeout(() => {
		const e2 = el.getBoundingClientRect();
		const viewH = isWindow
			? window.innerHeight
			: (container as HTMLElement).clientHeight;
		const bottomGap = viewH - e2.bottom;
		if (bottomGap < minBottomGap) {
			const delta = minBottomGap - bottomGap;
			if (isWindow) window.scrollBy({ top: delta, behavior: "smooth" });
			else
				(container as HTMLElement).scrollBy({ top: delta, behavior: "smooth" });
		}
	}, 120);
}

function EmailRenderer({
	threadIndex,
	numberOfMessages,
	showSubject,
	message,
	attachments,
	inlineShownIds = [],
	publicConfig,
	threadId,
	markSmtp,
	activeMailboxId,
    mailSubscription,
	identityMailboxes,
	children,
}: {
	threadIndex: number;
	numberOfMessages: number;
	showSubject?: boolean;
	message: MessageEntity;
	// attachments: MessageAttachmentEntity[];
	attachments: MessageAttachmentWithUrl[];
	inlineShownIds?: string[];
	publicConfig: PublicConfig;
	threadId: string;
	markSmtp: boolean;
	activeMailboxId: string;
    mailSubscription: FetchThreadMailSubsResult["byMessageId"] | null;
	identityMailboxes: FetchIdentityMailboxListResult;
	children?: React.ReactNode;
}) {
	const stripPrefixes = useStripSubjectPrefixes();
	const formatted = Temporal.Instant.from(message.createdAt.toISOString())
		.toZonedDateTimeISO(Temporal.Now.timeZoneId())
		.toLocaleString("en-US", {
			day: "2-digit",
			month: "short",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hour12: true,
		});

	const [showEditor, setShowEditor] = useState<boolean>(false);
	const [showEditorMode, setShowEditorMode] = useState<string>("reply");
	// Reply sent but still undoable: editor hidden, not destroyed.
	const [replyParked, setReplyParked] = useState(false);

	// Reply defaults to reply all when the message has recipients other than us;
	// otherwise it is a plain reply.
	const ownAddresses = useMemo(
		() => (identityMailboxes ?? []).map((im) => String(im.identity.value)),
		[identityMailboxes],
	);
	const hasOtherRecipients = useMemo(
		() => replyRecipients(message, ownAddresses).cc.length > 0,
		[message, ownAddresses],
	);
	const defaultReplyMode = hasOtherRecipients ? "replyAll" : "reply";
	const openEditor = (mode: string) => {
		setShowEditorMode(mode);
		setShowEditor(true);
	};

	const router = useRouter();
	const pathname = usePathname();
	const leaveThread = () => leaveThreadToList(router, pathname);
	// Immediate return to the list, already without the thread; the server follows
	// (see lib/pending-moves). On failure, the thread comes back with the error.
	const archiveMessage = () => {
		const id = String(threadId);
		moveWithUndo({
			mailboxId: activeMailboxId,
			threadIds: [id],
			message: "Archived",
			run: () => archiveThread(id, activeMailboxId, markSmtp, true),
			failure: "Archive failed",
			archive: true,
		});
		leaveThread();
	};
	const deleteMessage = () => {
		const id = String(threadId);
		moveWithUndo({
			mailboxId: activeMailboxId,
			threadIds: [id],
			message: "Moved to Trash",
			run: () => moveToTrash(id, activeMailboxId, markSmtp, true),
			failure: "Delete failed",
		});
		leaveThread();
	};
	// Unread: go back to the list, otherwise reopening the thread marks it read again.
	// Back to the list first, the server follows (the list updates on refresh);
	// an error is still reported.
	const unreadMessage = async () => {
		leaveThread();
		try {
			await markAsUnread(threadId, activeMailboxId, markSmtp, true);
			toast.success("Marked as unread", { position: "bottom-left" });
		} catch (err: any) {
			toast.error(err?.message ?? "Mark as unread failed");
		}
	};
	const editorRef = useRef<EmailEditorHandle>(null);
	const seenRef = useRef(null);

	const [sentMailboxId, setSentMailboxId] = useState<string | undefined>(
		undefined,
	);
	const params = useParams();
	const fetchSentMailbox = async () => {
		const { activeMailbox } = await fetchMailbox(
			String(params.identityPublicId),
			"sent",
		);
		setSentMailboxId(String(activeMailbox.id));
	};

	useEffect(() => {
		if (!sentMailboxId && !seenRef.current) {
			seenRef.current = true;
			fetchSentMailbox();
		}
	}, []);

	useEffect(() => {
		if (activeMailboxId) {
			markAsRead(threadId, activeMailboxId, markSmtp, true);
		}
	}, [activeMailboxId]);

	// Sender blocking from the menu (the server refuses free-mail and personal domains).
	const senderAddress = normalizeAddress(getMessageAddress(message, "from") ?? "");
	const senderDomain = emailDomain(senderAddress);
	const [blockTarget, setBlockTarget] = useState<{ kind: "address" | "domain"; value: string } | null>(null);

	const downloadEml = async () => {
		const { url } = await getRawMessageDownloadUrl(message.id);
		if (url) {
			window.open(url, "_blank");
		}
	};

	const [opened, { open, close }] = useDisclosure(false);
	const [emailString, setEmailString] = useState<string | null>(null);


	useEffect(() => {
		if (!opened) return;

		getRawMessageDownloadUrl(message.id).then(({ url }) => {
			if (!url) return;

			fetch(url)
				.then(res => res.text())
				.then(raw => setEmailString(raw.slice(0, 10000)));
		});
	}, [opened]);


	const formattedTime = useMemo(() => {
		return Temporal.Instant.from(message.createdAt.toISOString())
			.toZonedDateTimeISO(Temporal.Now.timeZoneId())
			.toLocaleString("en-GB", {
				day: "numeric",
				month: "long",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			})
			.replace(",", " at");
	}, [message.createdAt]);

	return (
		<>
			<Modal opened={opened} onClose={close} title="Original message" size="xl">
				<div className="text-sm border rounded-md overflow-hidden">
					{/* Header Rows */}
					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							Message ID
						</div>
						<div className="px-3 py-2 text-green-700 break-all">
							{message.messageId}
						</div>
					</div>

					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							Created on
						</div>
						<div className="px-3 py-2">{formattedTime}</div>
					</div>

					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							From
						</div>
						<div className="px-3 py-2">
							{String(message?.headersJson?.from?.text)}
						</div>
					</div>

					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							To
						</div>
						{/*<div className="px-3 py-2">suisse@dinebot.io</div>*/}
						<div className="px-3 py-2">
							{message?.headersJson?.to?.text
								? String(message.headersJson.to.text)
								: "undisclosed recipients"}
						</div>
					</div>

					<div className="grid grid-cols-[160px_1fr] border-b">
						<div className="bg-muted px-3 py-2 font-medium text-muted-foreground">
							Subject
						</div>
						<div className="px-3 py-2">
							{/*Google Workspace: Your invoice is available for dinebot.io*/}
							{message?.headersJson?.subject}
						</div>
					</div>

					{/*<div className="grid grid-cols-[160px_1fr] border-b">*/}
					{/*    <div className="bg-muted px-3 py-2 font-medium text-muted-foreground">*/}
					{/*        SPF*/}
					{/*    </div>*/}
					{/*    <div className="px-3 py-2">*/}
					{/*        <span className="text-green-600 font-semibold">PASS</span> with IP 209.85.220.69{" "}*/}
					{/*        <a href="#" className="text-blue-600 hover:underline">Learn more</a>*/}
					{/*    </div>*/}
					{/*</div>*/}

					{/*<div className="grid grid-cols-[160px_1fr] border-b">*/}
					{/*    <div className="bg-muted px-3 py-2 font-medium text-muted-foreground">*/}
					{/*        DKIM*/}
					{/*    </div>*/}
					{/*    <div className="px-3 py-2">*/}
					{/*        <span className="text-green-600 font-semibold">'PASS'</span> with domain google.com{" "}*/}
					{/*        <a href="#" className="text-blue-600 hover:underline">Learn more</a>*/}
					{/*    </div>*/}
					{/*</div>*/}

					{/*<div className="grid grid-cols-[160px_1fr]">*/}
					{/*    <div className="bg-muted px-3 py-2 font-medium text-muted-foreground">*/}
					{/*        DMARC*/}
					{/*    </div>*/}
					{/*    <div className="px-3 py-2">*/}
					{/*        <span className="text-green-600 font-semibold">'PASS'</span>{" "}*/}
					{/*        <a href="#" className="text-blue-600 hover:underline">Learn more</a>*/}
					{/*    </div>*/}
					{/*</div>*/}
				</div>

				{/* Action Buttons */}
				{/*<div className="flex justify-end gap-2 mt-4">*/}
				{/*<button*/}
				{/*    className="text-blue-600 hover:underline text-sm"*/}
				{/*    onClick={() => console.log("download original")}*/}
				{/*>*/}
				{/*    Download original*/}
				{/*</button>*/}
				{/*<button*/}
				{/*    className="text-blue-600 hover:underline text-sm"*/}
				{/*    onClick={() => navigator.clipboard.writeText("original message headers")}*/}
				{/*>*/}
				{/*    Copy to clipboard*/}
				{/*</button>*/}
				{/*</div>*/}

				<div
					className="
    bg-neutral-50 dark:bg-neutral-900
    border border-neutral-200 dark:border-neutral-800
    rounded-md mt-4 p-4 text-sm font-mono
    whitespace-pre-wrap break-words overflow-x-auto
    shadow-sm text-neutral-800 dark:text-neutral-200
  "
				>
					{emailString || "Loading raw message..."}
				</div>
			</Modal>

			{blockTarget && (
				<BlockSenderModal
					kind={blockTarget.kind}
					value={blockTarget.value}
					opened
					onClose={() => setBlockTarget(null)}
				/>
			)}
			<div className={"grid grid-cols-12"}>
				<div className={"col-span-12"}>
					{(showSubject ?? threadIndex === 0) && <div className={"flex gap-3 items-center"}>
						<div className="text-2xl font-semibold tracking-tight">
							{subjectForDisplay(message.subject, stripPrefixes) || "No Subject"}
						</div>
                        <MailUnsubscriber mailSubscription={mailSubscription} message={message}/>
                    </div>}
				</div>

				<div className={"md:col-span-6 col-span-12 flex flex-col"}>
					<div className={"mt-4 flex gap-2 items-baseline"}>
						<div className={"text-base font-semibold capitalize"}>
							{getMessageName(message, "from") ??
								slugify(String(getMessageAddress(message, "from")), {
									separator: " ",
								})}
						</div>
						<div
							className={"text-xs text-muted-foreground"}
						>{`<${getMessageAddress(message, "from") ?? getMessageName(message, "from")}>`}</div>
					</div>
					<div className={"flex gap-1 items-center"}>
						<div className={"text-xs text-muted-foreground"}>
							to{" "}
							{(() => {
								// A blind-copy send has no To header; upstream displayed "<null>".
								const to = getMessageAddress(message, "to") ?? getMessageName(message, "to");
								return to ? `<${to}>` : "undisclosed recipients";
							})()}
						</div>
					</div>
				</div>

				{/*<div className={"col-span-6 my-1"}>*/}
				{/*    <div className={"text-xs"}>{formatted}</div>*/}
				{/*</div>*/}

				<div
					className={
						"md:col-span-6 col-span-12 my-1 flex md:justify-end justify-between items-center gap-2 "
					}
				>
					<div className={"text-xs text-muted-foreground"}>{formatted}</div>
					<div className={"flex gap-1 justify-end items-center"}>
						{/* One-click actions in the header, without going through the menu. */}
						<Tooltip label="Reply all (r)" withArrow>
							<ActionIcon variant={"subtle"} color={"gray"} aria-label="Reply all" onClick={() => openEditor(defaultReplyMode)}>
								<ReplyAll size={18} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label="Copy this message (for an AI agent)" withArrow>
							<ActionIcon variant={"subtle"} color={"gray"} aria-label="Copy message" onClick={() => copyMailToClipboard({ messageId: message.id })}>
								<ClipboardCopy size={18} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label="Copy the whole thread (for an AI agent)" withArrow>
							<ActionIcon variant={"subtle"} color={"gray"} aria-label="Copy thread" onClick={() => copyMailToClipboard({ threadId: String(threadId) })}>
								<ClipboardList size={18} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label="Archive (a)" withArrow>
							<ActionIcon variant={"subtle"} color={"gray"} aria-label="Archive" onClick={archiveMessage}>
								<Archive size={18} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label="Mark as unread and back to the list" withArrow>
							<ActionIcon variant={"subtle"} color={"gray"} aria-label="Mark as unread" onClick={unreadMessage}>
								<Mail size={18} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label="Delete (e)" withArrow>
							<ActionIcon variant={"subtle"} color={"red"} aria-label="Delete" onClick={deleteMessage}>
								<Trash2 size={18} />
							</ActionIcon>
						</Tooltip>

						<div className={"cursor-pointer"}>
							<Menu shadow="md" width={175} position={"left-start"}>
								<Menu.Target>
									<EllipsisVertical size={18} />
								</Menu.Target>

								<Menu.Dropdown>
									<Menu.Item
										leftSection={<Reply size={14} />}
										onClick={() => openEditor("reply")}
									>
										Reply
									</Menu.Item>
									{hasOtherRecipients && (
										<Menu.Item
											leftSection={<ReplyAll size={14} />}
											onClick={() => openEditor("replyAll")}
										>
											Reply all
										</Menu.Item>
									)}
									<Menu.Item
										leftSection={<Forward size={14} />}
										onClick={() => openEditor("forward")}
									>
										Forward
									</Menu.Item>
									<Menu.Divider />
									<Menu.Item
										leftSection={<ClipboardCopy size={14} />}
										onClick={() => copyMailToClipboard({ messageId: message.id })}
									>
										Copy message
									</Menu.Item>
									<Menu.Item
										leftSection={<ClipboardList size={14} />}
										onClick={() => copyMailToClipboard({ threadId: String(threadId) })}
									>
										Copy thread
									</Menu.Item>
									<Menu.Divider />
									<Menu.Item
										leftSection={<Archive size={14} />}
										onClick={archiveMessage}
									>
										Archive
									</Menu.Item>
									<Menu.Item
										color="red"
										leftSection={<Trash2 size={14} />}
										onClick={deleteMessage}
									>
										Delete
									</Menu.Item>
									{senderAddress.includes("@") && (
										<>
											<Menu.Item
												color="red"
												leftSection={<Ban size={14} />}
												onClick={() => setBlockTarget({ kind: "address", value: senderAddress })}
											>
												Block {senderAddress}
											</Menu.Item>
											{senderDomain && !isFreeMailDomain(senderDomain) && (
												<Menu.Item
													color="red"
													leftSection={<Ban size={14} />}
													onClick={() => setBlockTarget({ kind: "domain", value: senderDomain })}
												>
													Block domain {senderDomain}
												</Menu.Item>
											)}
										</>
									)}
									<Menu.Divider />

									<Menu.Item
										leftSection={<Download size={14} />}
										onClick={downloadEml}
									>
										Download
									</Menu.Item>
									<Menu.Item leftSection={<Code size={14} />} onClick={open}>
										Show Original
									</Menu.Item>
								</Menu.Dropdown>
							</Menu>
						</div>
					</div>
				</div>
			</div>

			{children}

			<MessageAttachments
				attachments={attachments}
				publicConfig={publicConfig}
				hiddenIds={inlineShownIds}
			/>

			{threadIndex === numberOfMessages - 1 && !showEditor && (
				<div className={"flex gap-4 flex-wrap"}>
					<Button
						onClick={() => openEditor(defaultReplyMode)}
						leftSection={hasOtherRecipients ? <ReplyAll /> : <Reply />}
						variant={"outline"}
						radius={"xl"}
					>
						{hasOtherRecipients ? "Reply all" : "Reply"}
					</Button>
					<Button
						onClick={() => openEditor("forward")}
						rightSection={<Forward />}
						variant={"outline"}
						radius={"xl"}
					>
						Forward
					</Button>
					<Button
						onClick={archiveMessage}
						leftSection={<Archive />}
						variant={"outline"}
						radius={"xl"}
					>
						Archive
					</Button>
					<Button
						onClick={deleteMessage}
						leftSection={<Trash2 />}
						variant={"outline"}
						color={"red"}
						radius={"xl"}
					>
						Delete
					</Button>
				</div>
			)}

			{showEditor && (
				<div className={replyParked ? "hidden" : undefined}>
					<EmailEditor
						sentMailboxId={String(sentMailboxId)}
						ref={editorRef}
						publicConfig={publicConfig}
						message={message}
						identityMailboxes={identityMailboxes}
						onReady={(el) => {
							scrollToEditor(el, { offsetTop: 96, minBottomGap: 64 });
							requestAnimationFrame(() => editorRef.current?.focus());
						}}
						handleClose={() => {
							setShowEditor(false);
							setReplyParked(false);
						}}
						onParkedChange={setReplyParked}
						showEditorMode={showEditorMode}
					/>
				</div>
			)}
		</>
	);
}

export default EmailRenderer;
