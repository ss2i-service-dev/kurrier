"use client";

import { draftStamp } from "@/components/mailbox/default/draft-send-status";
import React, { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { createPortal } from "react-dom";
import { useKSignatureSlot } from "@/components/k/signature-slot";
import { Checkbox } from "@mantine/core";
import { ActionIcon, Button, Popover, Progress, Tooltip } from "@mantine/core";
import { Baseline, Eye, Paperclip, Save, Trash2, X as IconX } from "lucide-react";
import type { DraftContext } from "@/components/mailbox/default/editor/email-editor";
import { RichTextEditor } from "@mantine/tiptap";
import { useK, useNouvelle } from "@/components/k/ui-context";
import { formatBytes as kBytes } from "@/components/k/format";
import { kCreateAttachmentUploadUrl } from "@/lib/actions/k-uploads";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import { v4 as uuidv4 } from "uuid";
import { MessageEntity } from "@db";
import ScheduleSend from "@/components/mailbox/default/editor/schedule-send";
import {createAttachmentUploadUrl, createComposeAttachmentPreview} from "@/lib/actions/uploads-actions";
import { Viewer } from "@/components/k/attachments";
import { previewModeFor, toPreviewFile } from "@/lib/compose-attachment-preview";

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

// ss2i : formatOpen / onToggleFormat servent a la nouvelle interface (barre de
// mise en forme rangee au-dessus du texte). Classique : popover d'origine.
export default function EditorFooter({
	formatOpen = false,
	onToggleFormat,
}: {
	formatOpen?: boolean;
	onToggleFormat?: () => void;
} = {}) {
	const nouvelle = useNouvelle();
	const sigSlot = useKSignatureSlot();
	const t = useK();
	const { state } = useDynamicContext<{
		isPending: boolean;
		message: MessageEntity;
		signatureHtml?: string;
		draftRow?: MessageEntity | null;
		draft?: DraftContext;
	}>();

	// ss2i : brouillon repris, pieces jointes et choix de signature enregistres.
	const draftMeta = (state.draftRow?.metaData as any)?.draft ?? null;
	const initialAttachments: any[] = Array.isArray(draftMeta?.attachments)
		? draftMeta.attachments
		: [];

	// ss2i : moment programme (« ven. 13/11 08:00 »), affiche sur le bouton Envoyer.
	const [scheduledLabel, setScheduledLabel] = useState<string | null>(null);
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
		// ss2i : nouvelle interface, URL signee sans somme de controle (cf. k-uploads.ts).
		const { uploadUrl, key } = await (nouvelle ? kCreateAttachmentUploadUrl : createAttachmentUploadUrl)({
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
				else reject(t(`Upload failed: ${xhr.status}`, `Échec de l'envoi : ${xhr.status}`));
			};

			xhr.onerror = () => reject(t("Network error", "Erreur réseau"));

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

	// ss2i : envoi d'une liste de fichiers, partage par le bouton trombone et, dans la
	// nouvelle interface, le glisser-deposer sur l'editeur (meme logique qu'avant).
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

	// ss2i : nouvelle interface, deposer des fichiers n'importe ou sur l'editeur les joint.
	const footerRef = useRef<HTMLDivElement | null>(null);
	const addFilesRef = useRef(addFiles);
	addFilesRef.current = addFiles;
	useEffect(() => {
		if (!nouvelle) return;
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
	}, [nouvelle]);

	// ss2i : ouvrir la piece jointe telle que le destinataire la recevra (Samuel le 06/11 :
	// « pour etre sur d'avoir mis la bonne »). PDF, image, texte, video, audio : visionneuse
	// plein ecran, comme a la lecture ; Word, Excel, archive : le fichier dans un nouvel onglet.
	const [preview, setPreview] = useState<ReturnType<typeof toPreviewFile> | null>(null);
	const openPreview = async (name: string) => {
		const attachment = attachments.find((a) => a.filenameOriginal === name);
		if (!attachment) return;
		const viewer = previewModeFor(attachment) === "viewer";
		// Onglet ouvert pendant le clic : apres l'appel serveur, le bloqueur de fenetres le refuserait.
		const tab = viewer ? null : window.open("about:blank", "_blank");
		try {
			const urls = await createComposeAttachmentPreview(attachment.path, attachment.filenameOriginal);
			if (viewer) setPreview(toPreviewFile(attachment, urls));
			else if (tab) tab.location.href = urls.url;
			else window.open(urls.url, "_blank");
		} catch (err) {
			tab?.close();
			setUploads((prev) =>
				prev.map((u) => (u.name === name ? { ...u, status: "error", error: String(err) } : u)),
			);
		}
	};

	const removeUpload = (name: string) => {
		setUploads((prev) => prev.filter((u) => u.name !== name));
		// La piece retiree ne doit plus partir avec le message ni rester dans le brouillon.
		setAttachments((prev) => prev.filter((a) => a.filenameOriginal !== name));
	};

	const draft = state.draft;
	// ss2i : heure de creation du brouillon devant l'etat d'enregistrement (derniere edition).
	const createdAt = draft?.status.createdAt;
	const createdLabel = createdAt
		? `${t("Created", "Créé")} ${draftStamp(new Date(createdAt).toISOString())}`
		: "";
	const statusLabel =
		draft?.status.state === "saving"
			? t("Saving…", "Enregistrement…")
			: draft?.status.state === "error"
				? t("Not saved", "Non enregistré")
				: draft?.status.state === "saved" && draft.status.savedAt
					? `${t("saved", "modifié")} ${draftStamp(new Date(draft.status.savedAt).toISOString())}`
					: "";
	const draftLabel = [createdLabel, statusLabel].filter(Boolean).join(" · ");

	console.log("isPending", state)

	return (
		<>
			{/* ss2i (Outlook) : apercu a la place reelle de la signature (sous le texte, au-dessus de la citation). */}
			{signaturePreview && nouvelle && sigSlot &&
				createPortal(
					<div className={`k-signature group/sig px-4 pb-3 pt-1 ${includeSignature ? "" : "opacity-40"}`}>
						<div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-k-ink-3">
							<span className="h-px w-6 bg-k-line-strong" />
							<span>Signature, ajoutée à l'envoi</span>
							<label className="ml-auto flex cursor-pointer items-center gap-1.5 opacity-70 transition-opacity hover:opacity-100 group-hover/sig:opacity-100">
								<input
									type="checkbox"
									checked={includeSignature}
									onChange={(e) => setIncludeSignature(e.currentTarget.checked)}
									className="h-3.5 w-3.5 accent-[var(--k-accent)]"
								/>
								Inclure
							</label>
						</div>
						<div className="k-signature-body text-[13.5px] text-k-ink" dangerouslySetInnerHTML={{ __html: signaturePreview }} />
					</div>,
					sigSlot,
				)}
			{signaturePreview && !(nouvelle && sigSlot) && (
				<div className="px-3 pb-2">
					<div className="flex items-center justify-between gap-2 mb-1">
						<span className="text-xs text-neutral-500">
							{t("Signature (added when sending)", "Signature (ajoutée à l'envoi)")}
						</span>
						<Checkbox
							size="xs"
							label={t("Include", "Inclure")}
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
			{nouvelle && uploads.length > 0 && (
				<div className="k-uploads flex flex-wrap gap-2 px-4 pb-2 pt-1">
					{uploads.map((u) => {
						const uploading = u.status === "uploading" && u.progress < 100;
						const failed = u.status === "error";
						const open = () => openPreview(u.name);
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
									{failed ? "échec" : uploading ? `${u.progress} %` : kBytes(u.size)}
								</span>
								{u.status === "done" && (
									<button
										type="button"
										onClick={open}
										aria-label={`Aperçu de ${u.name}`}
										title="Aperçu, tel que le destinataire le recevra"
										className="flex h-6 w-6 shrink-0 items-center justify-center rounded-k-sm text-k-ink-3 hover:bg-k-hover hover:text-k-ink"
									>
										<Eye size={13} />
									</button>
								)}
								<button
									type="button"
									onClick={() => removeUpload(u.name)}
									aria-label={`Retirer ${u.name}`}
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
			{!nouvelle && uploads.length > 0 && (
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
												title="Aperçu, tel que le destinataire le recevra"
												onClick={() => openPreview(u.name)}
											>
												{u.name}
											</button>
										) : (
											<div className="truncate font-semibold text-sm text-neutral-900 dark:text-neutral-100">
												{u.name}
											</div>
										)}

										{u.status === "error" ? (
											<div className="text-xs text-red-600 dark:text-red-400" title={u.error}>
												{t("Upload failed, this file will not be sent", "Échec de l'envoi, ce fichier ne partira pas")}
											</div>
										) : (
											<div className="text-xs text-neutral-500">
												{formatBytes(u.size)}
											</div>
										)}
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


									{u.status === "done" && (
										<Tooltip label={t("Preview as the recipient will see it", "Aperçu, tel que le destinataire le recevra")} withArrow fz="xs">
											<ActionIcon
												variant="subtle"
												color="gray"
												aria-label={`Aperçu de ${u.name}`}
												onClick={() => openPreview(u.name)}
											>
												<Eye size={16} />
											</ActionIcon>
										</Tooltip>
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

			{preview && (
				<Viewer files={[preview] as any} index={0} onIndex={() => {}} onClose={() => setPreview(null)} />
			)}

			<div ref={footerRef} className="border-t items-center flex py-2 px-2">
				<div className="mx-2 flex items-center gap-[1px]">
					<Button
						loading={!!state.isPending}
						size="sm"
						type="submit"
						data-k-action={nouvelle ? "send" : undefined}
						title={nouvelle ? "Envoyer (Ctrl+Entrée)" : undefined}
						className={nouvelle ? "!rounded-l-[10px] !rounded-r-[3px] !px-4" : "!rounded-l-4xl !rounded-r-xs"}
					>
						{scheduledLabel ? `${t("Scheduled", "Programmé")} · ${scheduledLabel}` : t("Send", "Envoyer")}
					</Button>
					<ScheduleSend onLabelChange={setScheduledLabel} />
				</div>

				{nouvelle ? (
					<Tooltip label={formatOpen ? "Masquer la mise en forme" : "Mise en forme"} withArrow fz="xs">
						<ActionIcon
							variant={formatOpen ? "light" : "subtle"}
							color={formatOpen ? "brand" : "gray"}
							size="lg"
							radius="md"
							className="ml-1"
							aria-label="Mise en forme"
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

				{nouvelle ? (
				<Tooltip label="Joindre des fichiers" withArrow fz="xs">
				<ActionIcon
					onClick={triggerUpload}
					variant={nouvelle ? "subtle" : "transparent"}
					color={nouvelle ? "gray" : undefined}
					size={nouvelle ? "lg" : undefined}
					radius={nouvelle ? "md" : undefined}
					className="mx-2"
					aria-label={t("Attach files", "Joindre des fichiers")}
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
						<Tooltip label={t("Save draft (Ctrl+S)", "Enregistrer le brouillon (Ctrl+S)")} withArrow>
							<ActionIcon
								variant="transparent"
								aria-label={t("Save draft", "Enregistrer le brouillon")}
								onClick={() => void draft.save()}
							>
								<Save size={18} />
							</ActionIcon>
						</Tooltip>
						{draft.id && (
							<Tooltip label={t("Discard draft", "Supprimer le brouillon")} withArrow>
								<ActionIcon
									variant="transparent"
									color="red"
									aria-label={t("Discard draft", "Supprimer le brouillon")}
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
