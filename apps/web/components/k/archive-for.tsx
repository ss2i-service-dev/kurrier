"use client";
// "Archive for...": archive with an expiry. Next to each "Archive" button, which stays unchanged
// (and so does the `a` shortcut, which targets data-k-action="archive"). A menu with the
// durations (label, and on the right the date each one gives) then "Pick a date...": date only,
// no time (the expiry is the start of the day, browser time zone). Outside the Archive folder:
// archives with an expiry (mailActions.archive, toast with "Undo"). In the Archive folder: sets
// the expiry of threads already archived (setThreadExpiry), state visible on the button, toast
// at the end.
import React, { useMemo, useState } from "react";
import { Button, Loader, Menu, Modal } from "@mantine/core";
import { DatePicker } from "@mantine/dates";
import { useDisclosure } from "@mantine/hooks";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";
import KIconButton from "@/components/k/icon-button";
import { mailActions, scheduleRefresh } from "@/components/k/mail-store";
import { useShortcutHint } from "@/components/k/shortcuts-config";
import { useModernUi } from "@/components/k/ui-context";
import { setThreadExpiry } from "@/lib/actions/mailbox";
import { expiryMenuOptions, pickerDate } from "@/lib/archive-for";
import { formatExpiry } from "@common/thread-expiry";

type Props = {
	mailboxId: string;
	mailboxKind: string;
	smtp: boolean;
	/** Threads concerned, read on click (the selection changes between two renders). */
	threadIds: () => string[];
	/** Unread threads among them (folder counter); 0 by default. */
	unread?: () => number;
	/** The selection contains a starred thread: it never expires, the message says so. */
	starred?: () => boolean;
	/** Just before archiving: clear the selection, move to the next thread... */
	before?: () => void;
	/** Selection bar, classic list row: bare button with this class (icon only, like its neighbours) instead of a KIconButton. */
	bulkClassName?: string;
	/** Classic interface, open mail's bar: trigger supplied by the caller (Mantine ActionIcon), icon at the wanted size. */
	renderTrigger?: (t: {
		label: string;
		/** Tooltip: label and key (Shift+A) as set by the user. */
		tip: string;
		/** Mark read by /keyboard-shortcuts.js (Shift+A): to spread on the trigger. */
		mark: Record<string, string>;
		disabled: boolean;
		icon: (size: number) => React.ReactNode;
	}) => React.ReactElement;
	/** Context of Shift+A (/keyboard-shortcuts.js): the open mail or the selection bar; nothing for a list row. */
	shortcut?: "open" | "selection";
	size?: "sm" | "md";
};

export default function KArchiveFor({
	mailboxId,
	mailboxKind,
	smtp,
	threadIds,
	unread,
	starred,
	before,
	bulkClassName,
	renderTrigger,
	shortcut,
	size = "md",
}: Props) {
	// The --k-* tokens only exist in the modern interface: Tailwind grey for the menu date in classic.
	const modern = useModernUi();
	const inArchive = mailboxKind === "archive";
	const [menuOpened, setMenuOpened] = useState(false);
	const [pickerOpened, pickerDisclosure] = useDisclosure(false);
	const [picked, setPicked] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [options, setOptions] = useState(() => expiryMenuOptions(new Date()));
	const label = inArchive ? "Expiry..." : "Archive for...";
	const hint = useShortcutHint("archiveFor");
	const tip = hint ? `${label} (${hint.replace(/ \+ /g, "+")})` : label;
	// Mark read by /keyboard-shortcuts.js: Shift+A clicks the trigger of the context (never by
	// title, never the data-k-action of `a`).
	const mark: Record<string, string> = shortcut ? { "data-k-shortcut": `${shortcut}-archive-for` } : {};

	// Dates recomputed on opening: the tab stays open for days.
	const onMenuChange = (opened: boolean) => {
		if (opened) setOptions(expiryMenuOptions(new Date()));
		setMenuOpened(opened);
	};

	const pickedAt = pickerDate(picked);
	const tomorrow = useMemo(() => {
		const n = new Date();
		return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
	}, [pickerOpened]);

	async function apply(at: Date) {
		const ids = threadIds().map(String);
		if (!ids.length || saving) return;
		const iso = at.toISOString();
		pickerDisclosure.close();
		if (!inArchive) {
			before?.();
			mailActions.archive(ids, mailboxId, smtp, unread?.() ?? 0, iso, starred?.() ?? false);
			return;
		}
		setSaving(true);
		try {
			const res = await setThreadExpiry({ threadIds: ids, mailboxId, expiresAt: iso });
			if (!res.ok) {
				toast.error(res.reason, { position: "bottom-center" });
			} else if (res.skipped > 0) {
				toast.error(`${res.updated} of ${ids.length} updated: starred threads and threads also in the Inbox do not expire`, {
					position: "bottom-center",
				});
			} else {
				toast.success(`Will disappear on ${formatExpiry(at)}`, { position: "bottom-center" });
			}
			scheduleRefresh(300);
		} catch (e: any) {
			toast.error(e?.message ?? "Update failed", { position: "bottom-center" });
		} finally {
			setSaving(false);
		}
	}

	const icon = saving ? <Loader size={15} color="gray" /> : <CalendarClock className={bulkClassName ? "h-4 w-4" : undefined} />;
	const trigger = renderTrigger ? (
		renderTrigger({
			label,
			tip,
			mark,
			disabled: saving,
			icon: (px) => (saving ? <Loader size={px - 3} color="gray" /> : <CalendarClock size={px} />),
		})
	) : bulkClassName ? (
		<button type="button" aria-label={label} title={tip} disabled={saving} className={bulkClassName} {...mark}>
			{icon}
		</button>
	) : (
		<KIconButton size={size} label={label} shortcut={hint} disabled={saving} {...mark}>
			{icon}
		</KIconButton>
	);

	return (
		<>
			<Menu opened={menuOpened} onChange={onMenuChange} position="bottom-end" withinPortal zIndex={1002} width={230}>
				<Menu.Target>{trigger}</Menu.Target>
				<Menu.Dropdown>
					<Menu.Label>{inArchive ? "Disappears in..." : "Archive, then disappears in..."}</Menu.Label>
					{options.map((o) => (
						<Menu.Item
							key={o.id}
							onClick={() => apply(new Date(o.iso))}
							rightSection={<span className={`text-[12px] tabular-nums ${modern ? "text-k-ink-3" : "text-muted-foreground"}`}>{o.date}</span>}
						>
							{o.label}
						</Menu.Item>
					))}
					<Menu.Divider />
					<Menu.Item
						onClick={() => {
							setPicked(null);
							pickerDisclosure.open();
						}}
					>
						Pick a date...
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>

			<Modal
				centered
				opened={pickerOpened}
				onClose={pickerDisclosure.close}
				title={<span className="text-[15px] font-semibold">{inArchive ? "Disappears on..." : "Archive, then disappears on..."}</span>}
				size="sm"
				zIndex={1003}
			>
				{/* Inline calendar, not a DatePickerInput: its popover keeps Escape (the modal would not close). */}
				<div className="my-4 flex flex-col items-center gap-2">
					<DatePicker
						value={picked}
						onChange={(v) => setPicked(typeof v === "string" ? v : v ? String(v) : null)}
						firstDayOfWeek={1}
						minDate={tomorrow}
					/>
					<span className="text-[13px]">{pickedAt ? `${inArchive ? "Disappears" : "Archive, then disappears"} on ${formatExpiry(pickedAt)}` : "Pick a day in the calendar"}</span>
				</div>
				<Button
					fullWidth
					disabled={!picked}
					onClick={() => {
						if (pickedAt) apply(pickedAt);
					}}
				>
					{inArchive ? "Apply" : "Archive"}
				</Button>
			</Modal>
		</>
	);
}
