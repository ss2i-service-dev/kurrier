"use client";
// List row under the pointer, deduced from the pointer position and not from
// mouseenter / :hover.
//
// Problem: deleting, archiving or pinning several threads in a row from the hover actions only
// worked once or twice. The clicked row leaves the list, the next one moves up under the
// motionless pointer: no mouseenter is emitted as long as the mouse does not move, so its
// actions (mounted only after a hover) did not exist, and the next click opened the thread
// instead of acting.
//
// Here, the last pointer position is kept; on every move, scroll or change of the list (row
// removed, moved), the row under the pointer is recomputed by elementFromPoint. Each row
// subscribes to a boolean "am I the hovered row": only the old and the new row redraw.
import React from "react";

export const ROW_SELECTOR = ".k-row[data-thread-id]";

let x = -1;
let y = -1;
let hot: string | null = null;
const listeners = new Set<() => void>();
let frame = 0;
let installed = false;

/** Thread id of the row that contains `el`, or null. */
export function rowIdOf(el: Element | null): string | null {
	const row = el?.closest?.(ROW_SELECTOR) as HTMLElement | null | undefined;
	return row?.dataset.threadId ?? null;
}

function setHot(id: string | null) {
	if (id === hot) return;
	hot = id;
	listeners.forEach((l) => l());
}

function pick() {
	frame = 0;
	if (x < 0 || typeof document === "undefined") return setHot(null);
	setHot(rowIdOf(document.elementFromPoint(x, y)));
}

function schedule() {
	if (!frame && typeof window !== "undefined") frame = window.requestAnimationFrame(pick);
}

/**
 * Recomputes the row under the pointer after a change of the list: at the next render, then
 * once animations and server renders are over.
 */
export function refreshRowHover() {
	if (typeof window === "undefined") return;
	schedule();
	window.setTimeout(schedule, 150);
	window.setTimeout(schedule, 500);
}

function install() {
	if (installed || typeof window === "undefined") return;
	installed = true;
	const move = (e: PointerEvent) => {
		// Touch: no hover.
		if (e.pointerType === "touch") return;
		x = e.clientX;
		y = e.clientY;
		schedule();
	};
	const leave = () => {
		x = y = -1;
		schedule();
	};
	window.addEventListener("pointermove", move, { passive: true });
	window.addEventListener("pointerdown", move, { passive: true });
	window.addEventListener("scroll", schedule, { passive: true, capture: true });
	document.documentElement.addEventListener("pointerleave", leave);
	window.addEventListener("blur", leave);
}

function subscribe(l: () => void) {
	install();
	listeners.add(l);
	return () => {
		listeners.delete(l);
	};
}

/** True when the pointer is on the row of thread `threadId`. */
export function useRowHot(threadId: string): boolean {
	return React.useSyncExternalStore(
		subscribe,
		() => hot === threadId,
		() => false,
	);
}
