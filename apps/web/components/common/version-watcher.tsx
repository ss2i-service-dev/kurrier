"use client";

// Recharge l'onglet quand une nouvelle version de Courrier est deployee (lib/app-version.ts).
// Verifie a l'ouverture, au retour sur l'onglet et toutes les 2 minutes tant qu'il est visible.
// Pendant la redaction d'un mail, propose de recharger au lieu de le faire.
import { useEffect } from "react";
import { toast } from "sonner";
import { onNewVersion } from "@/lib/app-version";

const LOADED = process.env.NEXT_PUBLIC_BUILD_VERSION ?? "";
const RELOADED_KEY = "ss2i-reloaded-for-version";

export function VersionWatcher() {
	useEffect(() => {
		if (!LOADED) return;
		let busy = false;
		const check = async () => {
			if (busy || document.visibilityState !== "visible") return;
			busy = true;
			try {
				const res = await fetch("/api/version", { cache: "no-store" });
				const served = res.ok ? ((await res.json()) as { version?: string }).version ?? null : null;
				const action = onNewVersion({
					loaded: LOADED,
					served,
					reloadedFor: sessionStorage.getItem(RELOADED_KEY),
					composing: !!document.querySelector('[contenteditable="true"]'),
				});
				if (action === "reload" && served) {
					sessionStorage.setItem(RELOADED_KEY, served);
					window.location.reload();
				} else if (action === "prompt") {
					toast("Nouvelle version de Courrier", {
						id: "ss2i-new-version",
						duration: Infinity,
						description: `Version ${served}. Recharger la page pour en profiter (le brouillon est sauvegardé).`,
						action: { label: "Recharger", onClick: () => window.location.reload() },
					});
				}
			} catch {
				// Serveur en cours de redemarrage : on reessaiera.
			} finally {
				busy = false;
			}
		};
		void check();
		const onVisible = () => void check();
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("focus", onVisible);
		const timer = setInterval(check, 120_000);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", onVisible);
			clearInterval(timer);
		};
	}, []);
	return null;
}
