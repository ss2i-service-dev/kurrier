"use client";
// Arrival of a new message. Both interfaces check every 20 s and refresh the
// list; in the modern interface only:
//  - a discreet sound (synthesized, no file), even with the tab in the
//    background;
//  - a red badge on the tab icon and the unread count in its title
//    ("(3) Mail - Inbox");
//  - the list refreshes by itself (immediately if the tab is visible, when
//    returning to the tab otherwise).
// The browser only allows sound after a first interaction with the page (click,
// key): the audio context is unlocked at that moment.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { kInboxPulse } from "@/lib/actions/k-pulse";
import { tabSectionOf, tabTitle } from "@/lib/tab-identity";

// After a deployment, an open tab stays on the old version: its server actions
// no longer exist ("Failed to find Server Action") and the user's first action
// (read, unread...) reloads the page abruptly. The pulse detects this earlier
// (two failed calls in a row) and offers to reload, never forcing it (a message
// may be being written).
let staleShown = false;
function announceNewVersion(modern: boolean) {
	if (staleShown) return;
	staleShown = true;
	toast("A new version of Kurrier is available", {
		id: "k-new-version",
		description: "Reload the page to get it (your drafts are saved).",
		duration: Infinity,
		position: "bottom-center",
		action: { label: "Reload", onClick: () => window.location.reload() },
	});
}

const POLL_MS = 20_000;
const SOUND_KEY = "k-new-mail-sound";

// Sound preference (per browser), shared with the account menu.
const soundListeners = new Set<() => void>();
function readSound() {
	try {
		return localStorage.getItem(SOUND_KEY) !== "off";
	} catch {
		return true;
	}
}
export function setNewMailSound(on: boolean) {
	try {
		localStorage.setItem(SOUND_KEY, on ? "on" : "off");
	} catch {}
	soundListeners.forEach((l) => l());
	if (on) playChime();
}
export function useNewMailSound() {
	return useSyncExternalStore(
		(l) => {
			soundListeners.add(l);
			return () => soundListeners.delete(l);
		},
		readSound,
		() => true,
	);
}

let audio: AudioContext | null = null;
function ctx() {
	if (typeof window === "undefined") return null;
	if (!audio) {
		const C = window.AudioContext || (window as any).webkitAudioContext;
		if (!C) return null;
		audio = new C();
	}
	return audio;
}

/** Two soft, short notes (C6 then G6), low volume. */
export function playChime() {
	const ac = ctx();
	if (!ac) return;
	if (ac.state === "suspended") ac.resume().catch(() => {});
	const t0 = ac.currentTime + 0.02;
	[
		[1046.5, 0],
		[1568, 0.11],
	].forEach(([freq, delay]) => {
		const osc = ac.createOscillator();
		const gain = ac.createGain();
		osc.type = "sine";
		osc.frequency.value = freq;
		const t = t0 + delay;
		gain.gain.setValueAtTime(0, t);
		gain.gain.linearRampToValueAtTime(0.12, t + 0.015);
		gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
		osc.connect(gain).connect(ac.destination);
		osc.start(t);
		osc.stop(t + 0.5);
	});
}

// --- Badge on the tab icon ------------------------------------------------
let baseIcon: HTMLImageElement | null = null;
let baseHref: string | null = null;
let lastBadge = -1;

function iconLinks() {
	return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

function drawBadge(n: number) {
	const links = iconLinks();
	if (!links.length) return;
	// The base icon changes from one section to another (mail, calendar): read again on each call.
	const href = links[0].dataset.kBase || links[0].href;
	if (href !== baseHref) {
		baseHref = href;
		baseIcon = null;
	}
	if (n <= 0) {
		links.forEach((l) => {
			if (l.dataset.kBase) l.href = l.dataset.kBase;
		});
		lastBadge = 0;
		return;
	}
	const paint = () => {
		const size = 64;
		const canvas = document.createElement("canvas");
		canvas.width = canvas.height = size;
		const g = canvas.getContext("2d");
		if (!g) return;
		if (baseIcon?.complete && baseIcon.naturalWidth) g.drawImage(baseIcon, 0, 0, size, size);
		// Red dot (no digit: the count is in the tab title).
		const r = 15;
		const cx = size - r - 1;
		const cy = r + 1;
		g.beginPath();
		g.arc(cx, cy, r, 0, Math.PI * 2);
		g.fillStyle = "#e5322d";
		g.fill();
		g.lineWidth = 4;
		g.strokeStyle = "#ffffff";
		g.stroke();
		const url = canvas.toDataURL("image/png");
		iconLinks().forEach((l) => {
			if (!l.dataset.kBase) l.dataset.kBase = l.href;
			l.href = url;
		});
		lastBadge = n;
	};
	if (!baseIcon) {
		baseIcon = new Image();
		baseIcon.onload = paint;
		baseIcon.onerror = paint;
		baseIcon.src = baseHref!;
	} else paint();
}

// --- Tab title: "(3) Mail - Inbox", "Calendar" ------------------------------
// Title per section (lib/tab-identity.ts), to tell a mail tab from a calendar tab; unread count
// and badge in the mail only.
let unreadForTitle = 0;

function wantedTitle() {
	// Custom folder: its name as shown in the sidebar.
	const active = document.querySelector<HTMLElement>('a[aria-current="page"] span.flex-1');
	return tabTitle(window.location.pathname, unreadForTitle, active?.textContent);
}

function applyTitle() {
	const t = wantedTitle();
	if (document.title !== t) document.title = t;
}

function applyBadge(n: number) {
	unreadForTitle = n;
	applyTitle();
	if (tabSectionOf(window.location.pathname) !== "mail") n = 0;
	// Next may restore the original tag while navigating: reapply.
	const stale = iconLinks().some((l) => (n > 0 ? !l.href.startsWith("data:") : l.href.startsWith("data:")));
	if (n !== lastBadge || stale) drawBadge(n);
}

export default function KNewMailNotifier({ modern }: { modern: boolean }) {
	const router = useRouter();
	const pathname = usePathname();

	// Modern interface: tab title kept up to date (Next resets it to "Kurrier" while navigating).
	useEffect(() => {
		if (!modern) return;
		applyTitle();
		const t = setTimeout(applyTitle, 300); // name of a custom folder, once the sidebar is rendered
		return () => clearTimeout(t);
	}, [modern, pathname]);
	useEffect(() => {
		if (!modern) return;
		const obs = new MutationObserver(() => {
			if (document.title !== wantedTitle()) applyTitle();
		});
		obs.observe(document.head, { subtree: true, childList: true, characterData: true });
		return () => obs.disconnect();
	}, [modern]);
	const soundOn = useNewMailSound();
	const soundRef = useRef(soundOn && modern);
	soundRef.current = soundOn && modern;
	const badgeRef = useRef(modern);
	badgeRef.current = modern;
	const latest = useRef<string | null | undefined>(undefined);
	const pendingRefresh = useRef(false);

	useEffect(() => {
		// Unlock audio on the first interaction (browser rule).
		const unlock = () => {
			if (!badgeRef.current) return;
			const ac = ctx();
			if (ac && ac.state === "suspended") ac.resume().catch(() => {});
		};
		window.addEventListener("pointerdown", unlock, { once: true, capture: true });
		window.addEventListener("keydown", unlock, { once: true, capture: true });

		let stopped = false;
		let inFlight = false;
		let failures = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const tick = async () => {
			if (inFlight) return;
			inFlight = true;
			if (timer) clearTimeout(timer);
			let res: Awaited<ReturnType<typeof kInboxPulse>> = null;
			try {
				res = await kInboxPulse();
				failures = 0;
			} catch {
				// The action itself is missing or unreachable (the server returns null on
				// an internal error): probably a new version.
				if (navigator.onLine && ++failures >= 2) announceNewVersion(badgeRef.current);
			}
			inFlight = false;
			if (stopped) return;
			if (res) {
				if (badgeRef.current) applyBadge(res.unread);
				const prev = latest.current;
				latest.current = res.latest;
				const isNew = prev !== undefined && !!res.latest && (!prev || res.latest > prev);
				if (isNew) {
					if (soundRef.current) playChime();
					if (document.visibilityState === "visible") router.refresh();
					else pendingRefresh.current = true;
				}
			}
			timer = setTimeout(tick, POLL_MS);
		};
		tick();

		const onVisible = () => {
			if (document.visibilityState !== "visible") return;
			if (pendingRefresh.current) {
				pendingRefresh.current = false;
				router.refresh();
			}
			// Immediate check when returning to the tab.
			tick();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisible);
			window.removeEventListener("pointerdown", unlock, true);
			window.removeEventListener("keydown", unlock, true);
		};
	}, [router]);

	return null;
}

/** Updates the badge right away (after reading a message, etc.). */
export async function refreshUnreadBadge() {
	const res = await kInboxPulse().catch(() => null);
	if (res) applyBadge(res.unread);
}
