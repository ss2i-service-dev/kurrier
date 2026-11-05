import { useModernUi } from "@/components/k/ui-context";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
	ActionIcon,
	Select,
	SelectProps,
	Group,
	Text,
	Input,
} from "@mantine/core";
import { Forward, Reply, ReplyAll } from "lucide-react";
import { replyRecipients } from "@/lib/reply-recipients";
import { useDynamicContext } from "@/hooks/use-dynamic-context";
import { MessageEntity } from "@db";
import { useMediaQuery } from "@mantine/hooks";
import EmailHeaderContacts from "@/components/mailbox/default/editor/email-header-contacts";
import {FetchIdentityMailboxListResult} from "@/lib/actions/mailbox";
import {useParams} from "next/navigation";
import { RecipientDropZone, RecipientsDnDProvider } from "@/components/mailbox/default/editor/recipients-dnd";
import { addressObjToList } from "@common/mail-client";

function EditorHeader({
	focusOnSubject,
	onModeChange,
	quoteScope = "last",
	onQuoteScopeChange,
}: {
	focusOnSubject?: () => void;
	// The mode and quote scope are lifted to the editor (preview, form).
	onModeChange?: (mode: "reply" | "replyAll" | "forward" | "compose") => void;
	quoteScope?: "last" | "thread";
	onQuoteScopeChange?: (scope: string) => void;
}) {
	const modern = useModernUi();
	const { state } = useDynamicContext<{
		isPending: boolean;
		message: MessageEntity;
		showEditorMode: "reply" | "replyAll" | "forward" | "compose";
		identityMailboxes: FetchIdentityMailboxListResult;
		draftRow?: MessageEntity | null;
	}>();

	type Mode = "reply" | "replyAll" | "forward" | "compose";

	// Resumed draft: the fields start from what was saved (as long as the mode is
	// unchanged); otherwise from recipients computed from the original message.
	const draftRow = state.draftRow ?? null;
	const draftValues = useMemo(
		() => ({
			to: addressObjToList(draftRow?.to),
			cc: addressObjToList(draftRow?.cc),
			bcc: addressObjToList(draftRow?.bcc),
		}),
		[draftRow],
	);
	const [initialMode] = useState<Mode>(() => {
		if (!draftRow) return state.showEditorMode;
		const m = (draftRow.metaData as any)?.draft?.mode;
		if (m === "reply" && state.message) return draftValues.cc.length ? "replyAll" : "reply";
		if (m === "forward" && state.message) return "forward";
		return "compose";
	});
	const [mode, setMode] = useState<Mode>(initialMode);
	const fromDraft = !!draftRow && mode === initialMode;
	useEffect(() => {
		onModeChange?.(mode);
	}, [mode, onModeChange]);
	// Quote scope of a reply, editable before sending.
	const isReplyMode = mode === "reply" || mode === "replyAll";
	const quoteOptions = [
		{ value: "last", label: "Quote last message" },
		{ value: "thread", label: "Quote whole thread" },
	];

	// Recipients computed from the original message: Reply-To or sender in "To";
	// in "Reply all", the other recipients go in "Cc", our own addresses excluded.
	const recipients = useMemo(
		() =>
			replyRecipients(
				state?.message,
				(state.identityMailboxes ?? []).map((im) => String(im.identity.value)),
			),
		[state.message, state.identityMailboxes],
	);
	const toValues = useMemo(
		() =>
			fromDraft
				? draftValues.to
				: mode === "forward" || mode === "compose"
					? []
					: recipients.to,
		[fromDraft, draftValues, mode, recipients],
	);
	const ccValues = useMemo(
		() => (fromDraft ? draftValues.cc : mode === "replyAll" ? recipients.cc : []),
		[fromDraft, draftValues, mode, recipients],
	);
	const bccValues = fromDraft ? draftValues.bcc : [];

	const [ccActive, setCcActive] = useState(ccValues.length > 0);
	const [bccActive, setBccActive] = useState(bccValues.length > 0);
	// Focus on open. New message or forward: the "To" field; reply: the body
	// (taken by the editor), not the already filled recipients. Cc / Bcc added
	// with a click take the focus.
	const [focusField, setFocusField] = useState<"cc" | "bcc" | null>(null);
	const focusOf = (n: "to" | "cc" | "bcc") =>
		n === "to" ? mode === "compose" || mode === "forward" : focusField === n;
	useEffect(() => {
		if (ccValues.length > 0) setCcActive(true);
	}, [ccValues]);

	const options = useMemo(
		() => [
			{ value: "reply", label: "Reply", Icon: Reply },
			...(recipients.cc.length > 0
				? [{ value: "replyAll", label: "Reply all", Icon: ReplyAll }]
				: []),
			{ value: "forward", label: "Forward", Icon: Forward },
		],
		[recipients],
	);

	// The server only knows reply / forward / new: "replyAll" is just a reply
	// variant with pre-filled Cc.
	const serverMode = mode === "replyAll" ? "reply" : mode;

	const renderOption: SelectProps["renderOption"] = ({ option }) => {
		const ItemIcon =
			options.find((o) => o.value === option.value)?.Icon ?? Reply;
		return (
			<Group gap="xs">
				<ItemIcon size={16} />
				<Text size={"sm"}>{option.label}</Text>
			</Group>
		);
	};

	const CurrentIcon = (options.find((o) => o.value === mode)?.Icon ??
		Reply) as typeof Reply;

	const computedSubject = useMemo(() => {
		if (!state.message) return "";

		const original = state.message.subject?.trim() || "";

		const cleaned = original.replace(/^(re|fwd)\s*:\s*/gi, "");

		if (mode === "reply" || mode === "replyAll") return `Re: ${cleaned}`;
		if (mode === "forward") return `Fwd: ${cleaned}`;
		return cleaned;
	}, [state.message, mode]);

	const [subject, setSubject] = useState(
		draftRow ? (draftRow.subject ?? "") : computedSubject,
	);

	// The saved draft subject wins on the first render; a mode change then
	// recomputes the subject as usual.
	const keepDraftSubject = useRef(!!draftRow);
	useEffect(() => {
		if (keepDraftSubject.current) {
			keepDraftSubject.current = false;
			return;
		}
		setSubject(computedSubject);
	}, [computedSubject]);

	const isMobile = useMediaQuery("(max-width: 768px)");

	// No Mantine FocusTrap on the subject: it was enabled as soon as a recipient
	// changed and pulled the focus back to the subject while typing in the body.
	// Enter or Tab in the subject moves to the message body.
	const focusBody = (from: HTMLElement) => {
		const body = from.closest("form")?.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
		body?.focus();
	};

	const params = useParams() as {
		identityPublicId?: string;
		mailboxSlug?: string;
	};
	const [identityPublicId, setIdentityPublicId] = useState<string>(params.identityPublicId || "");
	const fromOptions = useMemo(() => {
		return state.identityMailboxes.map((item) => ({
			value: item.identity.publicId,
			label: item.identity.value,
		}));
	}, [state.identityMailboxes]);

	// Drag and drop of recipients between To, Cc and Bcc; dropping on a hidden
	// field reveals it.
	const activateField = (n: "to" | "cc" | "bcc") => {
		if (n === "cc") setCcActive(true);
		if (n === "bcc") setBccActive(true);
	};

	// Modern interface, rearranged header (same fields, same logic): mode and
	// quote scope on top, then one aligned row per field.
	if (modern) {
		const row = "flex min-h-[42px] items-center gap-2 border-b border-k-line px-4";
		const label = "w-11 shrink-0 text-[13px] text-k-ink-3";
		const recipients = (n: "to" | "cc" | "bcc", values: string[]) => (
			<EmailHeaderContacts
				key={`${n}-${mode}`}
				name={n}
				autoFocus={focusOf(n)}
				defaultValues={values}
				onChange={() => {}}
			/>
		);
		const ghostSelect = { variant: "unstyled" as const, size: "xs" as const, comboboxProps: { withinPortal: true, position: "bottom-start" as const, offset: 6, zIndex: 3000 } };
		return (
			<RecipientsDnDProvider onActivate={activateField}>
				<input type="hidden" name="mode" value={serverMode} />
				{state.message ? (
					<div className="k-editor-modes flex items-center gap-1 border-b border-k-line px-3 py-1">
						<Select
							{...ghostSelect}
							value={mode}
							onChange={(v) => v && setMode(v as Mode)}
							data={options}
							renderOption={renderOption}
							leftSection={<CurrentIcon size={14} />}
							leftSectionPointerEvents="none"
							w={170}
						/>
						{isReplyMode && (
							<Select {...ghostSelect} value={quoteScope} onChange={(v) => v && onQuoteScopeChange?.(v)} data={quoteOptions} w={230} />
						)}
					</div>
				) : null}

				<RecipientDropZone name="to" className={`${row} py-1`}>
					<span className={label}>To</span>
					<div className="min-w-0 flex-1">{recipients("to", toValues)}</div>
					<div className="flex shrink-0 items-center gap-1 text-[12.5px]">
						{!ccActive && (
							<RecipientDropZone name="cc" as="span">
								<button type="button" onClick={() => { setCcActive(true); setFocusField("cc"); }} className="rounded-k-sm px-1.5 py-0.5 text-k-ink-3 hover:bg-k-hover hover:text-k-ink">
									Cc
								</button>
							</RecipientDropZone>
						)}
						{!bccActive && (
							<RecipientDropZone name="bcc" as="span">
								<button type="button" onClick={() => { setBccActive(true); setFocusField("bcc"); }} className="rounded-k-sm px-1.5 py-0.5 text-k-ink-3 hover:bg-k-hover hover:text-k-ink">
									Bcc
								</button>
							</RecipientDropZone>
						)}
					</div>
				</RecipientDropZone>
				{ccActive && (
					<RecipientDropZone name="cc" className={`${row} py-1`}>
						<span className={label}>Cc</span>
						<div className="min-w-0 flex-1">{recipients("cc", ccValues)}</div>
					</RecipientDropZone>
				)}
				{bccActive && (
					<RecipientDropZone name="bcc" className={`${row} py-1`}>
						<span className={label}>Bcc</span>
						<div className="min-w-0 flex-1">{recipients("bcc", bccValues)}</div>
					</RecipientDropZone>
				)}

				<div className={row}>
					<span className={label}>Subject</span>
					<>
						<input
							name="subject"
							value={subject}
							onChange={(e) => setSubject(e.currentTarget.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === "Tab") {
									e.preventDefault();
									focusBody(e.currentTarget);
								}
							}}
							placeholder="Subject"
							className="h-10 min-w-0 flex-1 bg-transparent text-[14px] font-medium text-k-ink outline-none placeholder:font-normal placeholder:text-k-ink-3"
						/>
					</>
				</div>

				{fromOptions.length > 1 ? (
					<div className={row}>
						<span className={label}>From</span>
						<Select
							{...ghostSelect}
							size="sm"
							w={300}
							name="identityPublicId"
							onChange={(publicId) => publicId && setIdentityPublicId(publicId)}
							value={identityPublicId || null}
							data={fromOptions}
						/>
					</div>
				) : (
					<input type="hidden" name="identityPublicId" value={identityPublicId} />
				)}
			</RecipientsDnDProvider>
		);
	}

	return (
		<RecipientsDnDProvider onActivate={activateField}>
		{isMobile ? (
		<>
			<div
				className="border-b px-3 py-2 grid gap-3
                  grid-cols-1
                  sm:grid-cols-[auto,1fr,auto] sm:items-start"
			>
				{state.message ? (
					<div className="sm:pt-1">
						<Select
							value={mode}
							onChange={(v) => v && setMode(v as Mode)}
							data={options}
							renderOption={renderOption}
							leftSection={<CurrentIcon size={14} />}
							leftSectionPointerEvents="none"
							variant="unstyled"
							className="text-sm"
							comboboxProps={{
								withinPortal: true,
								position: "bottom",
								offset: 8,
								zIndex: 2000,
							}}
						/>
						{isReplyMode && (
							<Select
								value={quoteScope}
								onChange={(v) => v && onQuoteScopeChange?.(v)}
								data={quoteOptions}
								variant="unstyled"
								className="text-sm"
								comboboxProps={{ withinPortal: true, position: "bottom", offset: 8, zIndex: 2000 }}
							/>
						)}
					</div>
				) : null}
				<input type="hidden" name="mode" value={serverMode} />

				<RecipientDropZone name="to" className="grid items-center gap-2 sm:grid-cols-[40px,1fr]">
					<span className="text-[13px] text-muted-foreground sm:text-right leading-6">
						To
					</span>
					<EmailHeaderContacts
						key={`to-${mode}`}
						name={"to"}
						autoFocus={focusOf("to")}
						defaultValues={toValues}
						onChange={() => {}}
					/>
</RecipientDropZone>
<div className="flex items-center justify-end gap-4 text-primary text-sm">
					{!ccActive && (
						<RecipientDropZone name="cc" as="span"><button type="button" onClick={() => { setCcActive(true); setFocusField("cc"); }}
							className="hover:underline"
							aria-label={"Add Cc"}
							title={"Add Cc"}
						>
							Cc </button></RecipientDropZone>
					)}
					{!bccActive && (
						<RecipientDropZone name="bcc" as="span"><button type="button" onClick={() => { setBccActive(true); setFocusField("bcc"); }}
							className="hover:underline"
							aria-label={"Add Bcc"}
							title={"Add Bcc"}
						>
							{"Bcc"} </button></RecipientDropZone>
					)}
				</div>
			</div>

			{ccActive && (
				<RecipientDropZone name="cc" className="border-b px-3 py-2 grid items-center gap-2 sm:grid-cols-[72px,1fr]">
<span className="text-[13px] text-muted-foreground sm:text-right leading-6">
Cc
</span>
					<EmailHeaderContacts
						key={`cc-${mode}`}
						name={"cc"}
						autoFocus={focusOf("cc")}
						defaultValues={ccValues}
						onChange={() => {}}
					/>
</RecipientDropZone> )} {bccActive && (
				<RecipientDropZone name="bcc" className="border-b px-3 py-2 grid items-center gap-2 sm:grid-cols-[72px,1fr]">
<span className="text-[13px] text-muted-foreground sm:text-right leading-6">
{"Bcc"}
</span>
					<EmailHeaderContacts
						name={"bcc"}
						autoFocus={focusOf("bcc")}
						defaultValues={bccValues}
						onChange={() => {}}
					/>
</RecipientDropZone> )}
<div className="border-b px-3 py-2 grid items-center gap-2 sm:grid-cols-[72px,1fr]"> <span className="text-[13px] text-muted-foreground sm:text-right leading-6"> {"Subject"}
				</span>
				<Input
					variant="unstyled"
					className="w-full text-base"
					name="subject"
					value={subject}
					onChange={(e) => setSubject(e.currentTarget.value)}
				/>
			</div>
			<div className="border-b px-3 py-2 grid items-center gap-2 sm:grid-cols-[72px,1fr]">
				<span className="text-[13px] text-muted-foreground sm:text-right leading-6">
					{"From"}
				</span>
				<div className={"my-2"}>
					<Select
						placeholder={"Pick value"}
						size="sm"
						variant="unstyled"
						w={260}
						name={"identityPublicId"}
						onChange={(publicId) => {
							if (publicId) setIdentityPublicId(publicId);
						}}
						value={identityPublicId || null}
						data={fromOptions}
						comboboxProps={{
							withinPortal: true,
							position: "bottom-start",
							offset: 8,
							zIndex: 3000,
						}}
					/>
				</div>
			</div>
		</>
	) : (
		<>
			<div className="border-b p-2 flex gap-2">
				{state.message ? (
					<div className="flex-shrink-0">
						<Select
							value={mode}
							onChange={(v) => v && setMode(v as Mode)}
							data={options}
							renderOption={renderOption}
							leftSection={<CurrentIcon size={16} />}
							leftSectionPointerEvents="none"
							variant="unstyled"
							w={130}
							comboboxProps={{
								withinPortal: true,
								position: "bottom",
								offset: 12,
								zIndex: 2000,
							}}
						/>
					</div>
				) : null}
				{state.message && isReplyMode ? (
					<div className="flex-shrink-0">
						<Select
							value={quoteScope}
							onChange={(v) => v && onQuoteScopeChange?.(v)}
							data={quoteOptions}
							variant="unstyled"
							w={190}
							comboboxProps={{ withinPortal: true, position: "bottom", offset: 12, zIndex: 2000 }}
						/>
					</div>
				) : null}
				<input type={"hidden"} name={"mode"} value={serverMode} />

				<div className="flex-grow flex justify-between gap-2 min-w-0">
					<div className="flex flex-1 min-w-0 items-stretch flex-col justify-start">
						<RecipientDropZone name="to" className="grid grid-cols-[2.5rem_1fr] items-start gap-2 py-1"> <span className="text-sm font-medium text-muted-foreground text-right leading-7">{"To"}</span>
							<EmailHeaderContacts
								key={`to-${mode}`}
								name={"to"}
						autoFocus={focusOf("to")}
								defaultValues={toValues}
								onChange={() => {}}
							/> </RecipientDropZone> {ccActive && (
							<RecipientDropZone name="cc" className="grid grid-cols-[2.5rem_1fr] items-start gap-2 py-1 border-t border-border/60"> <span className="text-sm font-medium text-muted-foreground text-right leading-7">Cc</span>
								<EmailHeaderContacts
									key={`cc-${mode}`}
									name={"cc"}
						autoFocus={focusOf("cc")}
									defaultValues={ccValues}
									onChange={() => {}}
								/> </RecipientDropZone> )} {bccActive && (
							<RecipientDropZone name="bcc" className="grid grid-cols-[2.5rem_1fr] items-start gap-2 py-1 border-t border-border/60"> <span className="text-sm font-medium text-muted-foreground text-right leading-7">{"Bcc"}</span>
								<EmailHeaderContacts
									name={"bcc"}
						autoFocus={focusOf("bcc")}
									defaultValues={bccValues}
									onChange={() => {}}
								/> </RecipientDropZone> )} </div> <div className="flex gap-2 items-center text-sm text-neutral-500">
						{!ccActive && (
							<RecipientDropZone name="cc" as="span"><ActionIcon onClick={() => { setCcActive(true); setFocusField("cc"); }} variant="transparent"> Cc </ActionIcon></RecipientDropZone>
						)}
						{!bccActive && (
							<RecipientDropZone name="bcc" as="span"><ActionIcon onClick={() => { setBccActive(true); setFocusField("bcc"); }} variant="transparent"> {"Bcc"} </ActionIcon></RecipientDropZone>
						)}
					</div>
				</div>
			</div>
			<div className={"border-b flex justify-start items-center px-2 gap-2"}>
				<span className="text-sm text-muted-foreground">{"Subject"}</span>
				<>
					<Input
						variant={"unstyled"}
						className={"w-full"}
						name={"subject"}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === "Tab") {
								e.preventDefault();
								focusBody(e.currentTarget);
							}
						}}
						value={subject}
						onChange={(e) => setSubject(e.currentTarget.value)}
					/>
				</>
			</div>
			<div className={"border-b flex justify-start items-center px-2 gap-2"}>
				<span className="text-sm text-muted-foreground">{"From"}</span>
				<div className={"my-2"}>
					<Select
						placeholder={"Pick value"}
						size="sm"
						variant="unstyled"
						w={260}
						name={"identityPublicId"}
						onChange={(publicId) => {
							if (publicId) setIdentityPublicId(publicId);
						}}
						value={identityPublicId || null}
						data={fromOptions}
						comboboxProps={{
							withinPortal: true,
							position: "bottom-start",
							offset: 8,
							zIndex: 3000,
						}}
					/>
				</div>
			</div>
		</>
		)}
		</RecipientsDnDProvider>
	);
}

export default EditorHeader;
