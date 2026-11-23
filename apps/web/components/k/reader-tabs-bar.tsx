"use client";
// Bar of the internal tabs, at the top of the reading pane (option Settings > Opening
// mail, off by default). A click displays the thread of the tab; the cross or a middle
// click closes it. Hidden on mobile, where the reading pane takes the whole screen.
import React, { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import { closeCompose, setActiveThread, setClosingThread } from "@/components/k/mail-store";
import { fetchOpenPrefs } from "@/lib/actions/open-prefs";
import {
	closeTabs,
	getTabs,
	loadOpenPrefsLocal,
	neighborOf,
	setOpenPrefsLocal,
	useOpenPrefs,
	useReaderTabs,
	type ReaderTab,
} from "@/components/k/reader-tabs";

/** Opening setting: local copy right away, then the server's. */
export function KOpenPrefsConfig() {
	useEffect(() => {
		loadOpenPrefsLocal();
		let alive = true;
		fetchOpenPrefs()
			.then((p) => alive && setOpenPrefsLocal(p))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, []);
	return null;
}

export default function KReaderTabsBar() {
	const prefs = useOpenPrefs();
	const tabs = useReaderTabs();
	const router = useRouter();
	const pathname = usePathname() ?? "";
	const current = pathname.match(/\/threads\/([^/]+)/)?.[1] ?? null;

	if (!prefs.tabs || !tabs.length) return null;

	const show = (tab: ReaderTab) => {
		if (tab.id === current) return;
		closeCompose();
		setActiveThread(tab.id);
		router.push(tab.url, { scroll: false });
	};

	const close = (tab: ReaderTab) => {
		const next = tab.id === current ? neighborOf(getTabs(), tab.id) : null;
		closeTabs([tab.id]);
		if (tab.id !== current) return;
		if (next) return show(next);
		// Last tab closed: back to the list, like the thread's "Close" button.
		setClosingThread(tab.id);
		setActiveThread(null);
		router.push(pathname.replace(/\/threads\/[^/]+\/?$/, ""), { scroll: false });
	};

	return (
		<div
			role="tablist"
			aria-label="Open mails"
			className="k-scroll hidden shrink-0 items-end gap-1 overflow-x-auto border-b border-k-line px-2 pt-1.5 lg:flex"
		>
			{tabs.map((tab) => {
				const active = tab.id === current;
				const label = tab.subject || "(no subject)";
				return (
					<div
						key={tab.id}
						role="tab"
						aria-selected={active}
						tabIndex={0}
						title={label}
						data-tab-id={tab.id}
						onClick={() => show(tab)}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								show(tab);
							}
						}}
						onMouseDown={(e) => e.button === 1 && e.preventDefault()}
						onAuxClick={(e) => {
							if (e.button !== 1) return;
							e.preventDefault();
							close(tab);
						}}
						className={`group flex max-w-[220px] min-w-[96px] shrink-0 cursor-pointer items-center gap-1.5 rounded-t-k-sm border border-b-0 px-2.5 py-1.5 text-[12.5px] transition-colors ${
							active
								? "border-k-line bg-k-selected font-medium text-k-ink"
								: "border-transparent text-k-ink-2 hover:bg-k-hover hover:text-k-ink"
						}`}
					>
						<span className="min-w-0 flex-1 truncate">{label}</span>
						<button
							type="button"
							aria-label={`Close "${label}"`}
							onClick={(e) => {
								e.stopPropagation();
								close(tab);
							}}
							className={`shrink-0 rounded p-0.5 text-k-ink-3 hover:bg-k-hover hover:text-k-ink ${
								active ? "" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
							}`}
						>
							<X size={12} />
						</button>
					</div>
				);
			})}
		</div>
	);
}
