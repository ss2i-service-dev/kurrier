"use client";
// ss2i : alerte de reunion partout dans courrier (messagerie, agenda, contacts...), a l'heure
// du rappel defini sur l'evenement dans Outlook (10 min par defaut a la creation dans courrier,
// aucun rappel = aucune alerte). Les rappels dus sont relus sur Microsoft Graph (reminderView :
// un rappel ferme ou repousse dans Outlook ne revient pas) toutes les 2 minutes et au retour
// sur l'onglet. Un bandeau fin occupe alors le haut de l'ecran, avec un son a l'apparition :
// titre, heure et lieu, compte a rebours (« dans 3 min », « a commence il y a 2 min »),
// « Rejoindre » pour une reunion Teams, « Dans 5 min » et « Fermer » (repousse ou ferme aussi
// dans Outlook). L'application est decalee d'autant (body et hauteurs plein ecran) : le
// bandeau ne cache rien. Il s'en va 10 minutes apres le debut. Notification du bureau en plus
// quand l'onglet est en arriere-plan et que le navigateur l'autorise.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Video, X } from "lucide-react";
import { safeTimeZone, utcToZoned } from "@common/outlook-calendar";
import type { DueReminder } from "@common/outlook-graph";
import { dismissOutlookReminder, outlookCalendarBoxes, snoozeOutlookReminder } from "@/lib/actions/outlook-calendar";
import { agendaRead } from "@/components/outlook-calendar/agenda-api";

const FETCH_MS = 2 * 60_000;
const TICK_MS = 5_000;
/** Le bandeau s'en va 10 minutes apres le debut. */
export const ALERT_AFTER_MIN = 10;
const BAR_H = 40;

const read = (k: string) => {
	try {
		return localStorage.getItem(k);
	} catch {
		return null;
	}
};
const tz = () => safeTimeZone(read("ss2i.agenda.tz"));
const nowLocal = () => utcToZoned(Date.now(), tz());
/** Minutes (decimales) de `a` a `b`, deux "YYYY-MM-DDTHH:mm" du meme fuseau. */
const minutesTo = (a: string, b: string) => (Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60_000;

/** Rappel a afficher maintenant : heure du rappel passee, reunion pas finie ni commencee depuis plus de 10 min. */
export function alertDue(r: DueReminder, now: string): boolean {
	return r.fireAt <= now && r.end > now && minutesTo(now, r.start) >= -ALERT_AFTER_MIN;
}

export function countdownLabel(start: string, now: string): string {
	const m = Math.round(minutesTo(now, start));
	if (m >= 60 * 24) return `Le ${start.slice(8, 10)}/${start.slice(5, 7)} à ${start.slice(11, 16)}`;
	if (m >= 60) return `Commence dans ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
	if (m > 0) return `Commence dans ${m} min`;
	if (m === 0) return "Commence maintenant";
	return `A commencé il y a ${-m} min`;
}

// Le bandeau prend sa place en haut : tout ce qui est plein ecran (h-svh, barre laterale
// fixe) descend d'autant tant qu'il est affiche.
const RESERVE_CSS = `
html.k-meeting-bar body { padding-top: ${BAR_H}px; }
html.k-meeting-bar .h-svh { height: calc(100svh - ${BAR_H}px) !important; }
html.k-meeting-bar .min-h-svh { min-height: calc(100svh - ${BAR_H}px) !important; }
html.k-meeting-bar .fixed.inset-y-0.h-svh { top: ${BAR_H}px !important; }
`;

/** Petit carillon (deux notes), sans fichier son. Muet si le navigateur bloque l'audio. */
function chime() {
	try {
		const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
		if (!Ctx) return;
		const ctx: AudioContext = new Ctx();
		const play = (freq: number, at: number) => {
			const o = ctx.createOscillator();
			const g = ctx.createGain();
			o.type = "sine";
			o.frequency.value = freq;
			g.gain.setValueAtTime(0.0001, ctx.currentTime + at);
			g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
			g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.6);
			o.connect(g).connect(ctx.destination);
			o.start(ctx.currentTime + at);
			o.stop(ctx.currentTime + at + 0.65);
		};
		play(880, 0);
		play(1318.5, 0.18);
		setTimeout(() => void ctx.close().catch(() => {}), 1500);
	} catch {}
}

export default function MeetingAlerts() {
	const box = useRef<string | null>(null);
	const due = useRef<DueReminder[]>([]);
	const announced = useRef(new Set<string>());
	const [closed, setClosed] = useState<Set<string>>(() => new Set());
	const [active, setActive] = useState<DueReminder[]>([]);
	const [now, setNow] = useState(nowLocal);

	const keyOf = (r: DueReminder) => `meet:${r.eventId}:${r.fireAt}`;

	const tick = useCallback(() => {
		const n = nowLocal();
		setNow(n);
		const list = due.current.filter((r) => alertDue(r, n)).sort((a, b) => a.start.localeCompare(b.start));
		setActive(list);
		let fresh = false;
		for (const r of list) {
			const k = keyOf(r);
			if (announced.current.has(k)) continue;
			announced.current.add(k);
			fresh = true;
			if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
				try {
					const notif = new Notification(r.title, { body: `${countdownLabel(r.start, n)} · ${r.start.slice(11, 16)}`, tag: k });
					notif.onclick = () => {
						window.focus();
						notif.close();
					};
				} catch {}
			}
		}
		if (fresh) chime();
	}, []);

	const fetchDue = useCallback(async () => {
		if (!box.current) {
			// Boite deja choisie dans l'agenda : pas d'appel de plus (le serveur la verifie).
			const saved = read("ss2i.agenda.box");
			if (saved) box.current = saved;
			else {
				const boxes = await outlookCalendarBoxes().catch(() => []);
				if (!boxes.length) return false;
				box.current = boxes[0].identityPublicId;
			}
		}
		// Route en parallele (pas une action serveur : elle ne retarde pas le reste de la page).
		const res = await agendaRead<{ reminders: DueReminder[] }>("reminders", { identityPublicId: box.current, tz: tz() });
		if (res.ok) due.current = res.reminders;
		else if (/introuvable|n'est pas une boîte/i.test(res.error)) box.current = null;
		tick();
		return true;
	}, [tick]);

	useEffect(() => {
		let alive = true;
		let fetchTimer: ReturnType<typeof setInterval> | undefined;
		// Premiere lecture un peu apres l'ouverture : la page passe d'abord.
		const first = setTimeout(() => {
			void fetchDue().then((ok) => {
				if (!alive || !ok) return;
				fetchTimer = setInterval(() => document.visibilityState === "visible" && void fetchDue(), FETCH_MS);
			});
		}, 2_500);
		const tickTimer = setInterval(tick, TICK_MS);
		const onFocus = () => void fetchDue();
		window.addEventListener("focus", onFocus);
		return () => {
			alive = false;
			clearTimeout(first);
			if (fetchTimer) clearInterval(fetchTimer);
			clearInterval(tickTimer);
			window.removeEventListener("focus", onFocus);
		};
	}, [fetchDue, tick]);

	const shown = active.filter((r) => !closed.has(keyOf(r)));
	const visible = shown.length > 0;

	useEffect(() => {
		const root = document.documentElement;
		root.classList.toggle("k-meeting-bar", visible);
		return () => root.classList.remove("k-meeting-bar");
	}, [visible]);

	if (!visible) return null;
	const r = shown[0];
	const m = minutesTo(now, r.start);
	const hide = () => setClosed((c) => new Set(c).add(keyOf(r)));
	// Fermer et repousser valent aussi dans Outlook.
	const dismiss = () => {
		hide();
		due.current = due.current.filter((x) => x !== r);
		if (box.current) void dismissOutlookReminder({ identityPublicId: box.current, id: r.eventId }).catch(() => {});
	};
	const snooze = () => {
		hide();
		const at = utcToZoned(Date.now() + 5 * 60_000, tz());
		due.current = due.current.map((x) => (x === r ? { ...x, fireAt: at } : x));
		if (box.current) void snoozeOutlookReminder({ identityPublicId: box.current, id: r.eventId, at, tz: tz() }).catch(() => {});
	};

	return (
		<>
			<style>{RESERVE_CSS}</style>
			<div
				role="status"
				aria-live="polite"
				className="fixed inset-x-0 top-0 z-[250] flex items-center gap-3 border-b border-black/10 bg-[#ecebfa] px-3 text-[13px] text-[#252423] dark:border-white/10 dark:bg-[#2b2a4a] dark:text-white"
				style={{ height: BAR_H }}
			>
				<span className={`h-2 w-2 shrink-0 rounded-full ${m <= 0 ? "animate-pulse bg-red-500" : "bg-[#5b5fc7]"}`} />
				<span className="min-w-0 truncate">
					<span className="font-semibold">{r.title}</span>
					<span className="opacity-70">
						{" "}
						· {r.start.slice(11, 16)} – {r.end.slice(11, 16)}
						{r.location ? ` · ${r.location}` : ""}
					</span>
				</span>
				<span className={`shrink-0 font-medium ${m <= 0 ? "text-red-600 dark:text-red-300" : "text-[#4f52b2] dark:text-[#c5c6ff]"}`}>{countdownLabel(r.start, now)}</span>
				{shown.length > 1 && <span className="shrink-0 text-[12px] opacity-60">+{shown.length - 1} autre{shown.length > 2 ? "s" : ""}</span>}
				<span className="ml-auto flex shrink-0 items-center gap-1.5">
					{r.joinUrl && (
						<a
							href={r.joinUrl}
							target="_blank"
							rel="noopener noreferrer"
							onClick={dismiss}
							className="inline-flex items-center gap-1.5 rounded-md bg-[#5b5fc7] px-3 py-1 text-[12.5px] font-semibold text-white hover:bg-[#4f52b2]"
						>
							<Video className="h-3.5 w-3.5" /> Rejoindre
						</a>
					)}
					{m > 5 && (
						<button type="button" onClick={snooze} className="rounded-md px-2 py-1 text-[12.5px] hover:bg-black/5 dark:hover:bg-white/10">
							Dans 5 min
						</button>
					)}
					<button type="button" aria-label="Fermer" title="Fermer (aussi dans Outlook)" onClick={dismiss} className="rounded p-1 opacity-60 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10">
						<X className="h-4 w-4" />
					</button>
				</span>
			</div>
		</>
	);
}
