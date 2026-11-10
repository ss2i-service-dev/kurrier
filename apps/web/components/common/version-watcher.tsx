"use client";

// Onglet perime apres un deploiement (lib/app-version.ts, lib/stale-tab.ts) : la page est
// couverte d'un voile qui bloque toute interaction, puis rechargee. Samuel le 10/11 : « tu
// forces la personne à refresh et tu la laisses pas interagir avec l'application ».
// Detection : version servie differente (ouverture, retour sur l'onglet, toutes les 30 s),
// ou reponse « action serveur inconnue » de Next sur n'importe quel appel.
// Les brouillons en cours ont leur copie locale (lib/draft-backup.ts), recuperee au chargement.
import { useEffect, useSyncExternalStore } from "react";
import { isStaleActionResponse, onNewVersion } from "@/lib/app-version";
import { forceReload, getStale, subscribeStale } from "@/lib/stale-tab";

const LOADED = process.env.NEXT_PUBLIC_BUILD_VERSION ?? "";
const RELOADED_KEY = "ss2i-reloaded-for-version";
const CHECK_MS = 30_000;
const RELOAD_DELAY_MS = 1500;

let fetchPatched = false;
function watchServerActions() {
	if (fetchPatched || typeof window === "undefined") return;
	fetchPatched = true;
	const original = window.fetch.bind(window);
	window.fetch = async (...args: Parameters<typeof fetch>) => {
		const res = await original(...args);
		try {
			if (isStaleActionResponse(res.headers)) forceReload(null);
		} catch {}
		return res;
	};
}

function reloadNow(served: string | null) {
	try {
		if (served) sessionStorage.setItem(RELOADED_KEY, served);
	} catch {}
	window.location.reload();
}

export function VersionWatcher() {
	const stale = useSyncExternalStore(subscribeStale, getStale, () => null);

	useEffect(() => {
		watchServerActions();
		if (!LOADED) return;
		let busy = false;
		const check = async () => {
			if (busy) return;
			busy = true;
			try {
				const res = await fetch("/api/version", { cache: "no-store" });
				const served = res.ok ? ((await res.json()) as { version?: string }).version ?? null : null;
				let reloadedFor: string | null = null;
				try {
					reloadedFor = sessionStorage.getItem(RELOADED_KEY);
				} catch {}
				const action = onNewVersion({ loaded: LOADED, served, reloadedFor });
				if (action !== "none") forceReload(served, action === "reload");
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
		const timer = setInterval(check, CHECK_MS);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", onVisible);
			clearInterval(timer);
		};
	}, []);

	useEffect(() => {
		if (!stale?.autoReload) return;
		const t = setTimeout(() => reloadNow(stale.served), RELOAD_DELAY_MS);
		return () => clearTimeout(t);
	}, [stale]);

	if (!stale) return null;
	return (
		<div
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="ss2i-stale-title"
			style={{ position: "fixed", inset: 0, zIndex: 2147483647, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", pointerEvents: "all" }}
			onKeyDownCapture={(e) => e.stopPropagation()}
		>
			<div style={{ background: "var(--background, #fff)", color: "var(--foreground, #111)", borderRadius: 12, padding: "24px 28px", maxWidth: 420, boxShadow: "0 10px 40px rgba(0,0,0,0.35)", textAlign: "center", fontFamily: "inherit" }}>
				<div id="ss2i-stale-title" style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>
					Courrier a été mis à jour
				</div>
				<div style={{ fontSize: 14, opacity: 0.8, marginBottom: 18 }}>
					{stale.autoReload ? "Rechargement de la page…" : "Rechargez la page pour continuer."} Les brouillons en cours sont conservés.
				</div>
				<button
					type="button"
					autoFocus
					onClick={() => reloadNow(null)}
					style={{ padding: "8px 18px", borderRadius: 8, border: 0, background: "#16a34a", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
				>
					Recharger maintenant
				</button>
			</div>
		</div>
	);
}
