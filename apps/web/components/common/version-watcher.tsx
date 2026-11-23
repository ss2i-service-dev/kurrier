"use client";

// Stale tab after a redeploy (lib/app-version.ts, lib/stale-tab.ts), if the user turned on
// "Reload the page after an update": the page is covered by a veil that blocks every interaction,
// then reloaded. An old tab that keeps working while its server actions fail is worse than a
// reload.
// Detection: served version different (on opening, when the tab is back in view, every 30 s), an
// "unknown Server Action" answer from Next, or any failed Server Action call (immediate check of
// the version).
// Drafts being written have their local copy (lib/draft-backup.ts), resumed on load.
import { useEffect, useState, useSyncExternalStore } from "react";
import { isFailedActionCall, isStaleActionResponse, onNewVersion, takeReloadSlot } from "@/lib/app-version";
import { forceReload, getStale, setWatching, subscribeStale } from "@/lib/stale-tab";

const LOADED = process.env.NEXT_PUBLIC_BUILD_VERSION ?? "";
const RELOADED_KEY = "kurrier-reloaded-for-version";
const CHECK_MS = 30_000;
const RELOAD_DELAY_MS = 1500;

let fetchPatched = false;
let checkNow: (() => void) | null = null;
function watchServerActions() {
	if (fetchPatched || typeof window === "undefined") return;
	fetchPatched = true;
	const original = window.fetch.bind(window);
	window.fetch = async (...args: Parameters<typeof fetch>) => {
		const res = await original(...args);
		try {
			if (isStaleActionResponse(res.headers)) forceReload(null);
			else {
				const [input, init] = args;
				const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
				if (isFailedActionCall(headers as Headers | Record<string, string> | undefined, res)) checkNow?.();
			}
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
		setWatching(true);
		if (!LOADED) return () => setWatching(false);
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
				// Server restarting: try again later.
			} finally {
				busy = false;
			}
		};
		checkNow = () => void check();
		void check();
		const onVisible = () => void check();
		document.addEventListener("visibilitychange", onVisible);
		window.addEventListener("focus", onVisible);
		const timer = setInterval(check, CHECK_MS);
		return () => {
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("focus", onVisible);
			clearInterval(timer);
			checkNow = null;
			setWatching(false);
		};
	}, []);

	// Automatic reload only if this tab has not already reloaded in the last 5 minutes.
	const [capped, setCapped] = useState(false);
	useEffect(() => {
		if (!stale?.autoReload) return;
		let slot = false;
		try {
			slot = takeReloadSlot(window.sessionStorage, Date.now());
		} catch {}
		if (!slot) {
			setCapped(true);
			return;
		}
		const t = setTimeout(() => reloadNow(stale.served), RELOAD_DELAY_MS);
		return () => clearTimeout(t);
	}, [stale]);

	if (!stale) return null;
	const auto = stale.autoReload && !capped;
	return (
		<div
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="stale-tab-title"
			style={{ position: "fixed", inset: 0, zIndex: 2147483647, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.55)", backdropFilter: "blur(3px)", pointerEvents: "all" }}
			onKeyDownCapture={(e) => e.stopPropagation()}
		>
			<div style={{ background: "var(--background, #fff)", color: "var(--foreground, #111)", borderRadius: 12, padding: "24px 28px", maxWidth: 420, boxShadow: "0 10px 40px rgba(0,0,0,0.35)", textAlign: "center", fontFamily: "inherit" }}>
				<div id="stale-tab-title" style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>
					Kurrier has been updated
				</div>
				<div style={{ fontSize: 14, opacity: 0.8, marginBottom: 18 }}>
					{auto ? "Reloading the page..." : "Reload the page to continue."} Drafts in progress are kept.
				</div>
				<button
					type="button"
					autoFocus
					onClick={() => reloadNow(null)}
					style={{ padding: "8px 18px", borderRadius: 8, border: 0, background: "#16a34a", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
				>
					Reload now
				</button>
			</div>
		</div>
	);
}
