"use client";
// Main button of the Drive section ("New", styled like "New message"), file
// upload (picker + drag and drop over the whole window) and folder creation.
// This component is the sole owner of the uploader: the header buttons send it
// their commands through an event (driveCommand).
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, FolderPlus, Plus, Upload } from "lucide-react";
import { Menu, Modal, TextInput } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { addNewFolder } from "@/lib/actions/drive";
import { ReusableFormButton } from "@/components/common/reusable-form-button";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import { DriveState } from "@schema";
import DriveUploader, { DriveUploaderHandle } from "@/components/dashboard/drive/drive-uploader";

const EVENT = "k-drive-command";

/** Commands sent to the main button from the header (upload, new folder). */
export function driveCommand(cmd: "upload" | "folder") {
	window.dispatchEvent(new CustomEvent(EVENT, { detail: cmd }));
}

export default function KDriveNew() {
	const { state } = useDynamicContext<DriveState>();
	const ctx = state?.driveRouteContext;
	const canUpload = !!ctx?.driveVolume && ctx.scope === "cloud";
	const uploaderRef = useRef<DriveUploaderHandle | null>(null);
	const [folderOpened, folderHandlers] = useDisclosure(false);
	const [menuOpened, setMenuOpened] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [mounted, setMounted] = useState(false);
	const canUploadRef = useRef(canUpload);
	canUploadRef.current = canUpload;

	useEffect(() => setMounted(true), []);

	// Commands from the header
	useEffect(() => {
		const onCmd = (e: Event) => {
			if (!canUploadRef.current) return;
			const cmd = (e as CustomEvent).detail;
			if (cmd === "upload") uploaderRef.current?.openPicker();
			if (cmd === "folder") folderHandlers.open();
		};
		window.addEventListener(EVENT, onCmd);
		return () => window.removeEventListener(EVENT, onCmd);
	}, [folderHandlers]);

	// Drag and drop: only files coming from outside, and only inside a volume.
	useEffect(() => {
		let depth = 0;
		const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
		const onEnter = (e: DragEvent) => {
			if (!hasFiles(e) || !canUploadRef.current) return;
			depth += 1;
			setDragging(true);
		};
		const onOver = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
		};
		const onLeave = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			depth = Math.max(0, depth - 1);
			if (depth === 0) setDragging(false);
		};
		const onDrop = (e: DragEvent) => {
			if (!hasFiles(e)) return;
			e.preventDefault();
			depth = 0;
			setDragging(false);
			if (!canUploadRef.current) return;
			const items = Array.from(e.dataTransfer?.items ?? []);
			// dropped folders are ignored (upload only handles files)
			const files = items
				.filter((it) => it.kind === "file" && (it.webkitGetAsEntry?.()?.isFile ?? true))
				.map((it) => it.getAsFile())
				.filter((f): f is File => !!f);
			uploaderRef.current?.enqueue(files);
		};
		window.addEventListener("dragenter", onEnter);
		window.addEventListener("dragover", onOver);
		window.addEventListener("dragleave", onLeave);
		window.addEventListener("drop", onDrop);
		return () => {
			window.removeEventListener("dragenter", onEnter);
			window.removeEventListener("dragover", onOver);
			window.removeEventListener("dragleave", onLeave);
			window.removeEventListener("drop", onDrop);
		};
	}, []);

	return (
		<>
			<Menu
				shadow="md"
				width="target"
				position="bottom-start"
				opened={menuOpened}
				onChange={setMenuOpened}
				disabled={!canUpload}
			>
				<Menu.Target>
					<button
						type="button"
						disabled={!canUpload}
						title={canUpload ? undefined : "Open a volume to upload files"}
						className="k-focus group flex h-10 w-full items-center gap-2.5 rounded-k bg-k-accent px-3.5 text-[14px] font-medium text-k-accent-ink shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_1px_0_rgb(255_255_255/0.12)] transition-colors hover:bg-k-accent-hover disabled:opacity-50"
					>
						<Plus className="h-4 w-4" />
						<span className="flex-1 text-left">New</span>
						<ChevronDown className="h-4 w-4 opacity-80" />
					</button>
				</Menu.Target>
				<Menu.Dropdown>
					<Menu.Item
						leftSection={<Upload size={15} />}
						onClick={() => {
							setMenuOpened(false);
							uploaderRef.current?.openPicker();
						}}
					>
						<span className="text-[13px]">Upload files</span>
					</Menu.Item>
					<Menu.Item
						leftSection={<FolderPlus size={15} />}
						onClick={() => {
							setMenuOpened(false);
							folderHandlers.open();
						}}
					>
						<span className="text-[13px]">New folder</span>
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>

			{/* Upload progress: fixed panel at the bottom left, also visible on mobile */}
			{mounted &&
				createPortal(
					<div className="pointer-events-none fixed bottom-4 left-4 z-[400] w-[320px] max-w-[calc(100vw-2rem)] [&>*]:pointer-events-auto">
						<DriveUploader ref={uploaderRef} uploadStrategy="proxy" />
					</div>,
					document.body,
				)}

			{mounted &&
				dragging &&
				createPortal(
					<div className="pointer-events-none fixed inset-0 z-[500] flex items-center justify-center bg-[rgb(12_12_14/0.35)] p-6">
						<div className="flex flex-col items-center gap-2 rounded-k-pane border-2 border-dashed border-k-accent bg-k-surface px-10 py-8 text-center shadow-k-pop">
							<Upload className="h-6 w-6 text-k-accent" />
							<p className="text-[15px] font-semibold text-k-ink">Drop your files to upload them</p>
							<p className="text-[13px] text-k-ink-3">
								In {ctx?.withinPath && ctx.withinPath !== "/" ? ctx.withinPath : (ctx?.driveVolume?.label ?? "the volume")}
							</p>
						</div>
					</div>,
					document.body,
				)}

			<Modal opened={folderOpened} onClose={folderHandlers.close} title="New folder" centered size="sm" trapFocus={false}>
				<ReusableFormButton
					action={addNewFolder}
					label="Create folder"
					formWrapperClasses="flex flex-col gap-4"
					onSuccess={() => folderHandlers.close()}
					buttonProps={{ leftSection: <Plus size={16} />, className: "self-end" }}
				>
					<TextInput autoFocus name="name" label="Folder name" placeholder="e.g. Invoices 2026" required />
					<input type="hidden" name="path" value={ctx?.withinPath ?? "/"} />
					<input type="hidden" name="scope" value={ctx?.scope ?? ""} />
					<input type="hidden" name="publicId" value={ctx?.driveVolume?.publicId ?? ""} />
				</ReusableFormButton>
			</Modal>
		</>
	);
}
