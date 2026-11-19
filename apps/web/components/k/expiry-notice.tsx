"use client";
// ss2i : encart « Disparait le JJ/MM/AAAA » en haut d'un fil archive avec une duree de vie, et
// « Garder » pour annuler l'echeance (setThreadExpiry a null). Etat visible : bouton en attente,
// puis l'encart disparait ; echec : le message du serveur reste a l'ecran.
import React, { useState } from "react";
import { Loader } from "@mantine/core";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { setThreadExpiry } from "@/lib/actions/mailbox";
import { scheduleRefresh } from "@/components/k/mail-store";
import { formatExpiry } from "@common/thread-expiry";

export default function KExpiryNotice({ threadId, mailboxId, expiresAt }: { threadId: string; mailboxId: string; expiresAt: string }) {
	const [busy, setBusy] = useState(false);
	const [kept, setKept] = useState(false);
	const [error, setError] = useState<string | null>(null);
	if (kept) return null;

	const keep = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await setThreadExpiry({ threadId, mailboxId, expiresAt: null });
			if (!res.ok) {
				setError(res.reason);
				toast.error(res.reason, { position: "bottom-center" });
				return;
			}
			setKept(true);
			toast.success("Le fil est gardé", { position: "bottom-center" });
			scheduleRefresh(300);
		} catch (e: any) {
			const msg = e?.message ?? "La mise à jour a échoué";
			setError(msg);
			toast.error(msg, { position: "bottom-center" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-k bg-k-warn-soft px-3 py-2 text-[13px] text-k-ink-2">
			<CalendarClock className="h-4 w-4 shrink-0 text-k-warn" />
			<span className="min-w-0 flex-1">
				Disparaît le {formatExpiry(new Date(expiresAt))} : le fil ira alors à la Corbeille.
				{error && <span className="ml-2 text-k-danger">{error}</span>}
			</span>
			<button
				type="button"
				onClick={keep}
				disabled={busy}
				className="k-focus inline-flex h-7 items-center gap-1.5 rounded-k-sm px-2.5 text-[12.5px] font-medium text-k-accent hover:bg-k-accent-soft disabled:opacity-50"
			>
				{busy && <Loader size={12} color="gray" />}
				Garder
			</button>
		</div>
	);
}
