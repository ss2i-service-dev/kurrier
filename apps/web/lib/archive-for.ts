// "Archive for...": archive with an expiry, pure part of the menu (options, picked date, toast
// message). Date only, no time: the expiry is the start of the day (browser time zone). See
// apps/web/test/archive-expiry.ts.
import { EXPIRY_PRESETS, expiryFromPreset, formatExpiry, type ExpiryPresetId } from "../../../packages/common/src/thread-expiry";

export type ExpiryMenuOption = { id: ExpiryPresetId; label: string; date: string; iso: string };

// The 5 durations with the date each one gives today, shown on the right of the label.
export function expiryMenuOptions(now: Date): ExpiryMenuOption[] {
	return EXPIRY_PRESETS.map((p) => {
		const at = expiryFromPreset(p.id, now);
		return { id: p.id, label: p.label, date: formatExpiry(at), iso: at.toISOString() };
	});
}

// Mantine 8's DatePicker gives "YYYY-MM-DD" (a Date in earlier versions): always the start of that
// day in local time, never midnight UTC (the day before, east of Greenwich).
export function pickerDate(value: string | Date | null | undefined): Date | null {
	if (!value) return null;
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	if (!m) return null;
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Toast message. A starred thread never expires (mbth_expiry_guard trigger): say so rather than
// show a date that will not hold.
export function archivedMessage({ count, expiresAt, starred }: { count: number; expiresAt: Date | null; starred: boolean }): string {
	const many = count > 1;
	const base = many ? `${count} threads archived` : "Archived";
	if (!expiresAt) return base;
	if (starred) return `${base}. Starred threads do not expire.`;
	return `${base}, will disappear on ${formatExpiry(expiresAt)}`;
}

// Kind (inbox, archive, trash...) of the active folder among the identities' folders; empty if
// unknown. The classic interface only has the folder id in the open mail's bar.
export function mailboxKindOf(
	identityMailboxes: readonly { mailboxes?: readonly { id: string; kind: string }[] | null }[] | null | undefined,
	mailboxId: string,
): string {
	for (const im of identityMailboxes ?? []) {
		const box = (im?.mailboxes ?? []).find((m) => m && String(m.id) === String(mailboxId));
		if (box) return String(box.kind);
	}
	return "";
}
