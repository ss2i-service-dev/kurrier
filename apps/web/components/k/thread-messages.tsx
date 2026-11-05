"use client";
// Messages of a thread. Each message is a separate card (collapsed: one line;
// expanded: header, body, attachments). Collapsed messages in the middle of a
// long thread are grouped behind "N older messages". "Expand all / Collapse
// all" above when the thread has several messages.
import React, { createContext, useContext, useState } from "react";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";

type Signal = { mode: "expand" | "collapse"; n: number } | null;
const ExpandSignal = createContext<Signal>(null);
/** "Expand all / collapse all" order (null until one has been given). */
export const useExpandSignal = () => useContext(ExpandSignal);

export default function ThreadMessages({ expanded, children }: { expanded: boolean[]; children: React.ReactNode }) {
	const items = React.Children.toArray(children);
	const [showAll, setShowAll] = useState(false);
	const [signal, setSignal] = useState<Signal>(null);

	// Keep visible: the first, the expanded ones, and the last two.
	const keep = items.map((_, i) => showAll || i === 0 || expanded[i] || i >= items.length - 2);
	const out: React.ReactNode[] = [];
	let hiddenRun = 0;
	items.forEach((child, i) => {
		if (keep[i]) {
			if (hiddenRun > 0) out.push(<Collapsed key={`more-${i}`} n={hiddenRun} onClick={() => setShowAll(true)} />);
			hiddenRun = 0;
			out.push(child);
		} else hiddenRun++;
	});

	const send = (mode: "expand" | "collapse") => {
		if (mode === "expand") setShowAll(true);
		setSignal((s) => ({ mode, n: (s?.n ?? 0) + 1 }));
	};
	const tool =
		"flex items-center gap-1 rounded-k-sm px-2 py-1 text-[12px] text-k-ink-3 transition-colors hover:bg-k-hover hover:text-k-ink";

	return (
		<ExpandSignal.Provider value={signal}>
			{items.length > 1 && (
				<div className="-mt-1 mb-2 flex justify-end gap-1">
					<button type="button" className={tool} onClick={() => send("expand")}>
						<ChevronsUpDown size={13} /> Expand all
					</button>
					<button type="button" className={tool} onClick={() => send("collapse")}>
						<ChevronsDownUp size={13} /> Collapse all
					</button>
				</div>
			)}
			<div className="flex flex-col gap-2.5">{out}</div>
		</ExpandSignal.Provider>
	);
}

function Collapsed({ n, onClick }: { n: number; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="group relative flex w-full items-center py-1" aria-label={`Show ${n} messages`}>
			<span className="absolute inset-x-0 top-1/2 border-t border-dashed border-k-line-strong" />
			<span className="relative mx-auto rounded-full border border-k-line-strong bg-k-surface px-3 py-0.5 text-[12px] text-k-ink-2 transition-colors group-hover:border-k-accent group-hover:text-k-accent">
				{n} older message{n > 1 ? "s" : ""}
			</span>
		</button>
	);
}
