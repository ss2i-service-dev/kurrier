"use client";
// ss2i : encart « Disparait le JJ/MM/AAAA » en haut d'un fil archive avec une duree de vie, et
// « Garder » pour annuler l'echeance (setThreadExpiry a null). Etat visible : bouton en attente,
// puis l'encart disparait ; echec : le message du serveur reste a l'ecran.
import React, { useState } from "react";
import { Loader } from "@mantine/core";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { useNouvelle } from "@/components/k/ui-context";
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
	/** Marges du conteneur, au choix de l'appelant (mb-4 dans la nouvelle interface). */
	className?: string;
}) {
	// Les jetons --k-* n'existent que dans la nouvelle interface : couleurs Tailwind standard en classique.
	const nouvelle = useNouvelle();
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
		<div
			className={`${className} flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-[13px] ${
				nouvelle ? "rounded-k bg-k-warn-soft text-k-ink-2" : "rounded-md bg-orange-50 text-orange-900 dark:bg-orange-950/40 dark:text-orange-200"
			}`}
		>
			<CalendarClock className={`h-4 w-4 shrink-0 ${nouvelle ? "text-k-warn" : "text-orange-600 dark:text-orange-400"}`} />
			<span className="min-w-0 flex-1">
				Disparaît le {formatExpiry(new Date(expiresAt))} : le fil ira alors à la Corbeille.
				{error && <span className={`ml-2 ${nouvelle ? "text-k-danger" : "text-destructive"}`}>{error}</span>}
			</span>
			<button
				type="button"
				onClick={keep}
				disabled={busy}
				className={`k-focus inline-flex h-7 items-center gap-1.5 px-2.5 text-[12.5px] font-medium disabled:opacity-50 ${
					nouvelle ? "rounded-k-sm text-k-accent hover:bg-k-accent-soft" : "rounded text-primary hover:bg-muted"
				}`}
			>
				{busy && <Loader size={12} color="gray" />}
				Garder
			</button>
		</div>
	);
}
