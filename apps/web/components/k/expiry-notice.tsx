"use client";
// "Disappears on DD Mon YYYY" notice at the top of a thread archived for a chosen duration, and
// "Keep" to cancel the expiry (setThreadExpiry to null). Visible state: pending button, then the
// notice goes away; on failure the server message stays on screen.
import React, { useState } from "react";
import { Loader } from "@mantine/core";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { useModernUi } from "@/components/k/ui-context";
import { setThreadExpiry } from "@/lib/actions/mailbox";
import { scheduleRefresh } from "@/components/k/mail-store";
import { formatExpiry } from "@common/thread-expiry";

export default function KExpiryNotice({
	threadId,
	mailboxId,
	expiresAt,
	className = "mb-4",
}: {
	threadId: string;
	mailboxId: string;
	expiresAt: string;
	/** Margins of the container, the caller's choice (mb-4 in the modern interface). */
	className?: string;
}) {
	// The --k-* tokens only exist in the modern interface: standard Tailwind colours in classic.
	const modern = useModernUi();
	const [busy, setBusy] = useState(false);
	const [kept, setKept] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (kept) return null;

	const keep = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await setThreadExpiry({ threadIds: [threadId], mailboxId, expiresAt: null });
			if (!res.ok) {
				setError(res.reason);
				toast.error(res.reason, { position: "bottom-center" });
				return;
			}
			setKept(true);
			toast.success("Thread kept", { position: "bottom-center" });
			scheduleRefresh(300);
		} catch (e: any) {
			const msg = e?.message ?? "Update failed";
			setError(msg);
			toast.error(msg, { position: "bottom-center" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			className={`${className} flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[13px] ${
				modern ? "rounded-k bg-k-warn-soft text-k-ink-2" : "rounded-md bg-orange-50 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200"
			}`}
		>
			<CalendarClock className={`h-4 w-4 shrink-0 ${modern ? "text-k-warn" : "text-orange-600 dark:text-orange-400"}`} />
			<span className="min-w-0 flex-1">
				Disappears on {formatExpiry(new Date(expiresAt))}: the thread will then go to Trash.
				{error && <span className={`ml-2 ${modern ? "text-k-danger" : "text-destructive"}`}>{error}</span>}
			</span>
			<button
				type="button"
				onClick={keep}
				disabled={busy}
				className={`k-focus inline-flex h-7 items-center gap-1.5 px-2.5 text-[12.5px] font-medium disabled:opacity-50 ${
					modern ? "rounded-k-sm text-k-accent hover:bg-k-accent-soft" : "rounded text-primary hover:bg-muted"
				}`}
			>
				{busy && <Loader size={12} color="gray" />}
				Keep
			</button>
		</div>
	);
}
