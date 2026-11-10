"use client";
// SS2i : arrivee d'un nouveau message. Les deux interfaces verifient toutes les
// 20 s et actualisent la liste ; en Outlook seulement, comme dans Outlook :
//  - son discret (synthetise, pas de fichier), meme onglet en arriere-plan ;
//  - pastille rouge sur l'icone de l'onglet et nombre de non-lus dans son titre
//    (« (3) Kurrier - Boite de reception ») ;
//  - liste actualisee d'elle-meme (immediatement si l'onglet est visible, au
//    retour sur l'onglet sinon).
// Le navigateur n'autorise le son qu'apres une premiere interaction avec la page
// (clic, touche) : le contexte audio est debloque a ce moment-la.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { kInboxPulse } from "@/lib/actions/k-pulse";
import { tabSectionOf, tabTitle } from "@/lib/tab-identity";

const POLL_MS = 20_000;
const SOUND_KEY = "k-new-mail-sound";

// Preference du son (par navigateur), partagee avec le menu du compte.
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

/** Deux notes douces et courtes (do6 puis sol6), volume bas. */
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

// --- Pastille sur l'icone de l'onglet -------------------------------------
let baseIcon: HTMLImageElement | null = null;
let baseHref: string | null = null;
let lastBadge = -1;

function iconLinks() {
	return Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
}

function drawBadge(n: number) {
	const links = iconLinks();
	if (!links.length) return;
	// L'icone de base change d'une section a l'autre (mail, agenda) : relue a chaque appel.
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
		// Pastille rouge (sans chiffre : le nombre est dans le titre de l'onglet).
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

// --- Titre de l'onglet : « (3) Courrier - Boîte de réception », « Agenda » ---
// ss2i : titre par section (lib/tab-identity.ts), pour distinguer un onglet de mail d'un
// onglet d'agenda ; compteur et pastille de non lus seulement dans le mail.
let unreadForTitle = 0;

function wantedTitle() {
	// Dossier personnel : son nom tel qu'affiche dans la barre laterale.
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
	// Next peut remettre la balise d'origine en naviguant : on reapplique.
	const stale = iconLinks().some((l) => (n > 0 ? !l.href.startsWith("data:") : l.href.startsWith("data:")));
	if (n !== lastBadge || stale) drawBadge(n);
}

export default function KNewMailNotifier({ nouvelle }: { nouvelle: boolean }) {
	const router = useRouter();
	const pathname = usePathname();

	// Outlook : titre de l'onglet tenu a jour (Next le remet a « Kurrier » en naviguant).
	useEffect(() => {
		if (!nouvelle) return;
		applyTitle();
		const t = setTimeout(applyTitle, 300); // nom d'un dossier personnel, une fois la barre rendue
		return () => clearTimeout(t);
	}, [nouvelle, pathname]);
	useEffect(() => {
		if (!nouvelle) return;
		const obs = new MutationObserver(() => {
			if (document.title !== wantedTitle()) applyTitle();
		});
		obs.observe(document.head, { subtree: true, childList: true, characterData: true });
		return () => obs.disconnect();
	}, [nouvelle]);
	const soundOn = useNewMailSound();
	const soundRef = useRef(soundOn && nouvelle);
	soundRef.current = soundOn && nouvelle;
	const badgeRef = useRef(nouvelle);
	badgeRef.current = nouvelle;
	const latest = useRef<string | null | undefined>(undefined);
	const pendingRefresh = useRef(false);

	useEffect(() => {
		// Debloque l'audio a la premiere interaction (regle des navigateurs).
		const unlock = () => {
			if (!badgeRef.current) return;
			const ac = ctx();
			if (ac && ac.state === "suspended") ac.resume().catch(() => {});
		};
		window.addEventListener("pointerdown", unlock, { once: true, capture: true });
		window.addEventListener("keydown", unlock, { once: true, capture: true });

		let stopped = false;
		let inFlight = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const tick = async () => {
			if (inFlight) return;
			inFlight = true;
			if (timer) clearTimeout(timer);
			let res: Awaited<ReturnType<typeof kInboxPulse>> = null;
			try {
				res = await kInboxPulse();
			} catch {
				// Action introuvable (ancien bundle) : le voile de version-watcher.tsx est deja
				// pose par l'en-tete x-nextjs-action-not-found. Serveur qui redemarre : rien,
				// le prochain tour reessaie.
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
			// Verification immediate au retour sur l'onglet.
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

/** Remet a jour la pastille tout de suite (lecture d'un message, etc.). */
export async function refreshUnreadBadge() {
	const res = await kInboxPulse().catch(() => null);
	if (res) applyBadge(res.unread);
}
