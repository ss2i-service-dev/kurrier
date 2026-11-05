"use client";

import { draftStamp } from "@/components/mailbox/default/draft-send-status";
import React, { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { createPortal } from "react-dom";
import { useKSignatureSlot } from "@/components/k/signature-slot";
import { Checkbox } from "@mantine/core";
import { ActionIcon, Button, Popover, Progress, Tooltip } from "@mantine/core";
import { Baseline, Paperclip, Save, Trash2, X as IconX } from "lucide-react";
import type { DraftContext } from "@/components/mailbox/default/editor/email-editor";
import { RichTextEditor } from "@mantine/tiptap";
import { useModernUi } from "@/components/k/ui-context";
import { formatBytes as kBytes } from "@/components/k/format";
import { kCreateAttachmentUploadUrl } from "@/lib/actions/k-uploads";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import { v4 as uuidv4 } from "uuid";
import { MessageEntity } from "@db";
import ScheduleSend from "@/components/mailbox/default/editor/schedule-send";
import {createAttachmentDownloadUrl, createAttachmentUploadUrl} from "@/lib/actions/uploads-actions";

type UploadItem = {
	name: string;
	size: number;
	progress: number;
	status: "uploading" | "done" | "error";
	error?: string;
};

const formatBytes = (n: number) => {
	if (!Number.isFinite(n)) return "";
	const units = ["B", "KB", "MB", "GB"];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${Math.round(n)}${units[i]}`;
};

// formatOpen / onToggleFormat serve the modern interface (formatting bar docked
// above the text). Classic: the original popover.
export default function EditorFooter({
	formatOpen = false,
	onToggleFormat,
}: {
	formatOpen?: boolean;
	onToggleFormat?: () => void;
} = {}) {
	const modern = useModernUi();
	const sigSlot = useKSignatureSlot();
	const { state } = useDynamicContext<{
		isPending: boolean;
		message: MessageEntity;
		signatureHtml?: string;
		draftRow?: MessageEntity | null;
		draft?: DraftContext;
	}>();

	// Resumed draft: saved attachments and signature choice.
	const draftMeta = (state.draftRow?.metaData as any)?.draft ?? null;
	const initialAttachments: any[] = Array.isArray(draftMeta?.attachments)
		? draftMeta.attachments
		: [];

	const [includeSignature, setIncludeSignature] = useState(
		draftMeta ? draftMeta.includeSignature !== false : true,
	);
	const signaturePreview = useMemo(
		() =>
			state?.signatureHtml && typeof window !== "undefined"
				? DOMPurify.sanitize(state.signatureHtml)
				: "",
		[state?.signatureHtml],
	);

	const inputRef = useRef<HTMLInputElement | null>(null);
	const [uploads, setUploads] = useState<UploadItem[]>(() =>
		initialAttachments.map((a) => ({
			name: String(a.filenameOriginal || "attachment"),
			size: Number(a.sizeBytes ?? 0),
			progress: 100,
			status: "done" as const,
		})),
	);
	const [attachments, setAttachments] = useState<any[]>(initialAttachments);

	const newMessageId = useRef(uuidv4());

	const triggerUpload = () => inputRef.current?.click();

	const uploadFile = async (file: File): Promise<void> => {
		// Modern interface: signed URL without a checksum (see k-uploads.ts).
		const { uploadUrl, key } = await (modern ? kCreateAttachmentUploadUrl : createAttachmentUploadUrl)({
			fileName: file.name,
			contentType: file.type,
			messageId: newMessageId.current,
		});

		await new Promise<void>((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			xhr.open("PUT", uploadUrl);
			xhr.setRequestHeader(
				"Content-Type",
				file.type || "application/octet-stream"
			);

			xhr.upload.onprogress = (evt) => {
				if (!evt.lengthComputable) return;
				const pct = Math.round((evt.loaded / evt.total) * 100);

				setUploads((prev) =>
					prev.map((u) =>
						u.name === file.name ? { ...u, progress: pct } : u
					)
				);
			};

			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) resolve();
				else reject(`Upload failed: ${xhr.status}`);
			};

			xhr.onerror = () => reject("Network error");

			xhr.send(file);
		});

		setAttachments((prev) => [
			...prev,
			{
				path: key,
				sizeBytes: file.size,
				messageId: newMessageId.current,
				// bucketId: process.env.NEXT_PUBLIC_S3_BUCKET,
				filenameOriginal: file.name,
				contentType: file.type,
			},
		]);
	};

	// Uploads a list of files, shared by the paperclip button and, in the modern
	// interface, drag and drop onto the editor.
	const addFiles = async (files: File[]) => {
		for (const file of files) {
			setUploads((prev) => [
				...prev,
				{
					name: file.name,
					size: file.size,
					progress: 0,
					status: "uploading",
				},
			]);

			try {
				await uploadFile(file);

				setUploads((prev) =>
					prev.map((u) =>
						u.name === file.name
							? { ...u, progress: 100, status: "done" }
							: u
					)
				);
			} catch (err) {
				setUploads((prev) =>
					prev.map((u) =>
						u.name === file.name
							? {
								...u,
								progress: 100,
								status: "error",
								error: String(err),
							}
							: u
					)
				);
			}
		}
	};

	const onFileSelect = async (
		event: React.ChangeEvent<HTMLInputElement>
	) => {
		const files = event.target.files;
		if (!files?.length) return;
		const list = Array.from(files);
		event.target.value = "";
		await addFiles(list);
	};

	// Modern interface: dropping files anywhere on the editor attaches them.
	const footerRef = useRef<HTMLDivElement | null>(null);
	const addFilesRef = useRef(addFiles);
	addFilesRef.current = addFiles;
	useEffect(() => {
		if (!modern) return;
		const root = footerRef.current?.closest(".k-editor") as HTMLElement | null;
		if (!root) return;
		let depth = 0;
		const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
		const enter = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth++;
			root.setAttribute("data-k-drop", "");
		};
		const over = (e: DragEvent) => {
			if (hasFiles(e)) e.preventDefault();
		};
		const leave = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) root.removeAttribute("data-k-drop");
		};
		const drop = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			e.stopPropagation();
			depth = 0;
			root.removeAttribute("data-k-drop");
			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length) void addFilesRef.current(files);
		};
		root.addEventListener("dragenter", enter);
		root.addEventListener("dragover", over);
		root.addEventListener("dragleave", leave);
		root.addEventListener("drop", drop, true);
		return () => {
			root.removeEventListener("dragenter", enter);
			root.removeEventListener("dragover", over);
			root.removeEventListener("dragleave", leave);
			root.removeEventListener("drop", drop, true);
		};
	}, [modern]);

	const removeUpload = (name: string) => {
		setUploads((prev) => prev.filter((u) => u.name !== name));
		// A removed attachment must neither be sent with the message nor stay in the draft.
		setAttachments((prev) => prev.filter((a) => a.filenameOriginal !== name));
	};

	const draft = state.draft;
	// Draft creation time shown before the save state (last edit).
	const createdAt = draft?.status.createdAt;
	const createdLabel = createdAt
		? `Created ${draftStamp(new Date(createdAt).toISOString())}`
		: "";
	const statusLabel =
		draft?.status.state === "saving"
			? "Saving…"
			: draft?.status.state === "error"
				? "Not saved"
				: draft?.status.state === "saved" && draft.status.savedAt
					? `saved ${draftStamp(new Date(draft.status.savedAt).toISOString())}`
					: "";
	const draftLabel = [createdLabel, statusLabel].filter(Boolean).join(" · ");

	console.log("isPending", state)

	return (
		<>
			{/* Preview at the signature's real position (below the text, above the quote). */}
			{signaturePreview && modern && sigSlot &&
				createPortal(
					<div className={`k-signature group/sig px-4 pb-3 pt-1 ${includeSignature ? "" : "opacity-40"}`}>
						<div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-k-ink-3">
							<span className="h-px w-6 bg-k-line-strong" />
							<span>Signature, added when sending</span>
							<label className="ml-auto flex cursor-pointer items-center gap-1.5 opacity-70 transition-opacity hover:opacity-100 group-hover/sig:opacity-100">
								<input
									type="checkbox"
									checked={includeSignature}
									onChange={(e) => setIncludeSignature(e.currentTarget.checked)}
									className="h-3.5 w-3.5 accent-[var(--k-accent)]"
								/>
								Include
							</label>
						</div>
						<div className="k-signature-body text-[13.5px] text-k-ink" dangerouslySetInnerHTML={{ __html: signaturePreview }} />
					</div>,
					sigSlot,
				)}
			{signaturePreview && !(modern && sigSlot) && (
				<div className="px-3 pb-2">
					<div className="flex items-center justify-between gap-2 mb-1">
						<span className="text-xs text-neutral-500">
							{"Signature (added when sending)"}
						</span>
						<Checkbox
							size="xs"
							label={"Include"}
							checked={includeSignature}
							onChange={(e) => setIncludeSignature(e.currentTarget.checked)}
						/>
					</div>
					<div
						className={[
							"rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 p-2 text-sm bg-white text-neutral-900",
							includeSignature ? "" : "opacity-40",
						].join(" ")}
						dangerouslySetInnerHTML={{ __html: signaturePreview }}
					/>
				</div>
			)}
			<input
				type="hidden"
				name="includeSignature"
				value={includeSignature ? "true" : "false"}
			/>
			{modern && uploads.length > 0 && (
				<div className="k-uploads flex flex-wrap gap-2 px-4 pb-2 pt-1">
					{uploads.map((u) => {
						const uploading = u.status === "uploading" && u.progress < 100;
						const failed = u.status === "error";
						const open = async () => {
							const attachment = attachments.find((a) => a.filenameOriginal === u.name);
							if (!attachment) return;
							const { url } = await createAttachmentDownloadUrl(attachment.path);
							window.open(url, "_blank");
						};
						return (
							<div
								key={u.name}
								title={failed ? u.error : u.name}
								className={`relative flex max-w-[260px] items-center gap-2 overflow-hidden rounded-k border py-1.5 pl-2.5 pr-1 text-[12.5px] ${
									failed ? "border-k-danger/40 bg-k-danger-soft" : "border-k-line bg-k-surface-2"
								}`}
							>
								<Paperclip size={14} className="shrink-0 text-k-ink-3" />
								<button
									type="button"
									disabled={u.status !== "done"}
									onClick={open}
									className="min-w-0 truncate text-left font-medium text-k-ink enabled:hover:underline"
								>
									{u.name}
								</button>
								<span className="shrink-0 text-[11.5px] text-k-ink-3">
									{failed ? "failed" : uploading ? `${u.progress}%` : kBytes(u.size)}
								</span>
								<button
									type="button"
									onClick={() => removeUpload(u.name)}
									aria-label={`Remove ${u.name}`}
									className="flex h-6 w-6 shrink-0 items-center justify-center rounded-k-sm text-k-ink-3 hover:bg-k-hover hover:text-k-ink"
								>
									<IconX size={13} />
								</button>
								{uploading && (
									<span className="absolute bottom-0 left-0 h-[2px] bg-k-accent transition-[width]" style={{ width: `${u.progress}%` }} />
								)}
							</div>
						);
					})}
				</div>
			)}
			{!modern && uploads.length > 0 && (
				<div className="w-full rounded-md p-2 flex flex-col gap-2">
					{uploads.map((u) => {
						const showProgress =
							u.status === "uploading" && u.progress < 100;

						return (
							<div
								key={u.name}
								className="flex justify-between items-center w-full max-w-xl bg-zinc-100 dark:bg-neutral-900 rounded-xl px-4 py-3"
							>
								<div className="flex items-center gap-3 min-w-0 flex-1">
									<Paperclip size={16} className="text-neutral-500 shrink-0" />

									<div className="min-w-0 flex-1">
										{u.status === "done" ? (
											<button
												type="button"
												className="truncate font-semibold text-sm text-base-600 hover:underline text-left w-full underline"
												onClick={async () => {
													const attachment = attachments.find(
														(a) => a.filenameOriginal === u.name
													);
													if (!attachment) return;

													const { url } = await createAttachmentDownloadUrl(
														attachment.path
													);

													window.open(url, "_blank");
												}}
											>
												{u.name}
											</button>
										) : (
											<div className="truncate font-semibold text-sm text-neutral-900 dark:text-neutral-100">
												{u.name}
											</div>
										)}

										<div className="text-xs text-neutral-500">
											{formatBytes(u.size)}
										</div>
									</div>
								</div>

								<div className="flex items-center gap-3">
									{showProgress && (
										<div className="w-32">
											<Progress
												value={u.progress}
												size="sm"
												radius="xl"
											/>
										</div>
									)}


									<ActionIcon
										variant="subtle"
										color="gray"
										onClick={() => removeUpload(u.name)}
									>
										<IconX size={16} />
									</ActionIcon>
								</div>
							</div>
						);
					})}
				</div>
			)}

			<div ref={footerRef} className="border-t items-center flex py-2 px-2">
				<div className="mx-2 flex items-center gap-[1px]">
					<Button
						loading={!!state.isPending}
						size="sm"
						type="submit"
						data-k-action={modern ? "send" : undefined}
						title={modern ? "Send (Ctrl+Enter)" : undefined}
						className={modern ? "!rounded-l-[10px] !rounded-r-[3px] !px-4" : "!rounded-l-4xl !rounded-r-xs"}
					>
						{"Send"}
					</Button>
					<ScheduleSend />
				</div>

				{modern ? (
					<Tooltip label={formatOpen ? "Hide formatting" : "Formatting"} withArrow fz="xs">
						<ActionIcon
							variant={formatOpen ? "light" : "subtle"}
							color={formatOpen ? "brand" : "gray"}
							size="lg"
							radius="md"
							className="ml-1"
							aria-label="Formatting"
							aria-pressed={formatOpen}
							onClick={onToggleFormat}
						>
							<Baseline size={18} />
						</ActionIcon>
					</Tooltip>
				) : (
				<Popover position="top-start" withArrow shadow="md">
					<Popover.Target>
						<ActionIcon variant="transparent">
							<Baseline />
						</ActionIcon>
					</Popover.Target>
					<Popover.Dropdown className="!p-0">
						<RichTextEditor.Toolbar
							sticky
							stickyOffset={60}
							className="!border-0"
						>
							<RichTextEditor.ControlsGroup>
								<RichTextEditor.Bold />
								<RichTextEditor.Italic />
								<RichTextEditor.Underline />
								<RichTextEditor.Strikethrough />
								<RichTextEditor.ClearFormatting />
							</RichTextEditor.ControlsGroup>

							<RichTextEditor.ControlsGroup>
								<RichTextEditor.BulletList />
								<RichTextEditor.OrderedList />
							</RichTextEditor.ControlsGroup>

							<RichTextEditor.ControlsGroup>
								<RichTextEditor.Undo />
								<RichTextEditor.Redo />
							</RichTextEditor.ControlsGroup>
						</RichTextEditor.Toolbar>
					</Popover.Dropdown>
				</Popover>
				)}

				{modern ? (
				<Tooltip label="Attach files" withArrow fz="xs">
				<ActionIcon
					onClick={triggerUpload}
					variant={modern ? "subtle" : "transparent"}
					color={modern ? "gray" : undefined}
					size={modern ? "lg" : undefined}
					radius={modern ? "md" : undefined}
					className="mx-2"
					aria-label={"Attach files"}
				>
					<Paperclip size={18} />
				</ActionIcon>
				</Tooltip>
				) : (
				<ActionIcon
					onClick={triggerUpload}
					variant="transparent"
					className="mx-2"
				>
					<Paperclip size={18} />
				</ActionIcon>
				)}

				{draft && (
					<div className="ml-auto flex items-center gap-1 text-xs text-neutral-500">
						<span
							className={draft.status.state === "error" ? "text-red-600" : undefined}
							title={draft.status.error}
						>
							{draftLabel}
						</span>
						<Tooltip label={"Save draft (Ctrl+S)"} withArrow>
							<ActionIcon
								variant="transparent"
								aria-label={"Save draft"}
								onClick={() => void draft.save()}
							>
								<Save size={18} />
							</ActionIcon>
						</Tooltip>
						{draft.id && (
							<Tooltip label={"Discard draft"} withArrow>
								<ActionIcon
									variant="transparent"
									color="red"
									aria-label={"Discard draft"}
									onClick={() => void draft.discard()}
								>
									<Trash2 size={18} />
								</ActionIcon>
							</Tooltip>
						)}
					</div>
				)}

				{state?.message && (
					<input
						type="hidden"
						name="originalMessageId"
						value={state.message.id}
					/>
				)}

				<input
					type="hidden"
					name="newMessageId"
					value={newMessageId.current}
				/>

				<input
					type="hidden"
					name="attachments"
					value={JSON.stringify(attachments)}
				/>

				<input
					ref={inputRef}
					type="file"
					multiple
					hidden
					onChange={onFileSelect}
				/>
			</div>
		</>
	);
}
