"use client";

import * as React from "react";
import { useMemo } from "react";
import { Clock, Paperclip, Trash } from "lucide-react";
import dayjs from "dayjs";
import { ReusableFormButton } from "@/components/common/reusable-form-button";
import { deleteScheduledDraft } from "@/lib/actions/mailbox";
import { useModernUi } from "@/components/k/ui-context";
import { KEmptyState } from "@/components/k/section";

type DraftMessageRow = {
	id: string;
	status:
		| "draft"
		| "scheduled"
		| "sending"
		| "sent"
		| "canceled"
		| "failed"
		| string;
	scheduledAt: string | Date | null;
	updatedAt?: string | Date | null;
	createdAt?: string | Date | null;
	payload: Record<string, any>;
};

type ScheduledListProps = {
	drafts: DraftMessageRow[];
	title?: string;
	onCancel?: (draft: DraftMessageRow) => void;
};

function formatDateLabel(input?: string | number | Date) {
	if (!input) return "";

	const d = dayjs(input);
	if (!d.isValid()) return "";

	const now = dayjs();

	if (d.isSame(now, "day")) {
		return d.format("h:mm A");
	}

	if (d.isSame(now, "year")) {
		return d.format("MMM D, h:mm A");
	}

	return d.format("MMM D, YYYY, h:mm A");
}

function getToLabel(payload: Record<string, any>) {
	const raw = payload?.to;
	if (!raw) return "No recipients";
	if (Array.isArray(raw)) {
		const parts = raw.filter(Boolean).slice(0, 3).map(String);
		return parts.join(", ") + (raw.length > 3 ? "…" : "");
	}
	return String(raw);
}

function getSubject(payload: Record<string, any>) {
	return payload?.subject ? String(payload.subject) : "(no subject)";
}

function getPreview(payload: Record<string, any>) {
	const t = payload?.text ?? payload?.html ?? "";
	return String(t)
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function hasAttachments(payload: Record<string, any>) {
	try {
		const a = payload?.attachments;
		if (!a) return false;
		if (Array.isArray(a)) return a.length > 0;
		const parsed = JSON.parse(String(a));
		return Array.isArray(parsed) && parsed.length > 0;
	} catch {
		return false;
	}
}

function ScheduledListItem({ draft }: { draft: DraftMessageRow }) {
	const scheduledLabel = formatDateLabel(
		draft.scheduledAt ?? draft.updatedAt ?? draft.createdAt ?? Date.now(),
	);
	const toLabel = getToLabel(draft.payload);
	const subject = getSubject(draft.payload);
	const preview = getPreview(draft.payload);
	const attachments = hasAttachments(draft.payload);

	return (
		<li className="px-3 py-2 transition-colors hover:bg-muted/50">
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 min-w-0">
						<div className="truncate font-semibold">{toLabel}</div>
						{attachments && (
							<Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />
						)}
					</div>

					<div className="truncate text-sm text-muted-foreground">
						<span className="truncate">{subject}</span>
						{preview && <span className="mx-1">–</span>}
						{preview && <span className="truncate">{preview}</span>}
					</div>

					<div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
						<Clock className="h-3.5 w-3.5" />
						<span className="whitespace-nowrap">
							Scheduled for {scheduledLabel}
						</span>
					</div>
				</div>

				<ReusableFormButton
					action={deleteScheduledDraft}
					actionIcon={true}
					actionIconProps={{
						className: "my-3",
						size: "sm",
						variant: "light",
						children: <Trash size={14} />,
						title: "Delete",
					}}
				>
					<input type="hidden" name="draftId" value={draft.id} />
				</ReusableFormButton>
			</div>
		</li>
	);
}

// Row of the modern interface (same data, same delete action).
function KScheduledItem({ draft }: { draft: DraftMessageRow }) {
	const when = draft.scheduledAt ?? draft.updatedAt ?? draft.createdAt;
	const d = when ? new Date(when) : null;
	const whenLabel =
		d && !Number.isNaN(d.getTime())
			? d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
			: "";
	const toLabel = getToLabel(draft.payload);
	const subject = getSubject(draft.payload);
	const preview = getPreview(draft.payload);
	return (
		<li className="group flex items-start gap-3 rounded-k px-3 py-2.5 transition-colors hover:bg-k-hover">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="truncate text-[13.5px] font-semibold text-k-ink">To: {toLabel}</span>
					{hasAttachments(draft.payload) && <Paperclip className="h-3.5 w-3.5 shrink-0 text-k-ink-3" />}
				</div>
				<div className="truncate text-[13px] text-k-ink-2">
					{subject}
					{preview && <span className="text-k-ink-3"> – {preview}</span>}
				</div>
				<div className="mt-1 flex items-center gap-1.5 text-[12px] text-k-accent">
					<Clock className="h-3.5 w-3.5" />
					<span className="whitespace-nowrap">Scheduled for {whenLabel}</span>
				</div>
			</div>
			<ReusableFormButton
				action={deleteScheduledDraft}
				actionIcon={true}
				actionIconProps={{
					size: "sm",
					variant: "subtle",
					color: "red",
					children: <Trash size={14} />,
					title: "Cancel scheduled send",
					"aria-label": "Cancel scheduled send",
				}}
			>
				<input type="hidden" name="draftId" value={draft.id} />
			</ReusableFormButton>
		</li>
	);
}

export default function ScheduledList({
	drafts,
	title,
	onCancel,
}: ScheduledListProps) {
	const scheduledDrafts = useMemo(() => {
		return drafts
			.filter((d) => String(d.status) === "scheduled")
			.sort((a, b) => {
				const aa = a.scheduledAt ? dayjs(a.scheduledAt).valueOf() : 0;
				const bb = b.scheduledAt ? dayjs(b.scheduledAt).valueOf() : 0;
				return aa - bb;
			});
	}, [drafts]);

	const modern = useModernUi();
	if (modern) {
		if (scheduledDrafts.length === 0) {
			return (
				<KEmptyState
					icon={<Clock size={22} strokeWidth={1.6} />}
					title="No scheduled messages"
					text="Schedule a message from the compose window: it will appear here until it is sent."
				/>
			);
		}
		return (
			<ul role="list" className="space-y-px px-1.5 pb-2">
				{scheduledDrafts.map((draft) => (
					<KScheduledItem key={draft.id} draft={draft} />
				))}
			</ul>
		);
	}

	if (scheduledDrafts.length === 0) {
		return (
			<div className="p-4 text-center text-base text-muted-foreground">
				No scheduled messages
			</div>
		);
	}

	return (
		<div className="rounded-xl border bg-background/50">
			<div className="flex items-center justify-between px-3 py-2 border-b">
				<div className="text-sm font-semibold">{title ?? "Scheduled"}</div>
				<div className="text-xs text-muted-foreground">
					{scheduledDrafts.length}
				</div>
			</div>

			<ul role="list" className="divide-y">
				{scheduledDrafts.map((draft) => (
					<ScheduledListItem key={draft.id} draft={draft} />
				))}
			</ul>
		</div>
	);
}
