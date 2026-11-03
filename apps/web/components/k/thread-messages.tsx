"use client";
// SS2i : regroupe les messages replies du milieu d'un long fil derriere un
// separateur « N messages plus anciens », comme le font les bons clients mail.
import React, { useState } from "react";

export default function ThreadMessages({ expanded, children }: { expanded: boolean[]; children: React.ReactNode }) {
	const items = React.Children.toArray(children);
	const [showAll, setShowAll] = useState(false);

	// On garde visibles : le premier, les deplies, et les deux derniers.
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
	return <div>{out}</div>;
}

function Collapsed({ n, onClick }: { n: number; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="group relative flex w-full items-center py-2" aria-label={`Afficher ${n} messages`}>
			<span className="absolute inset-x-0 top-1/2 border-t border-dashed border-k-line-strong" />
			<span className="relative mx-auto rounded-full border border-k-line-strong bg-k-surface px-3 py-0.5 text-[12px] text-k-ink-2 transition-colors group-hover:border-k-accent group-hover:text-k-accent">
				{n} message{n > 1 ? "s" : ""} plus ancien{n > 1 ? "s" : ""}
			</span>
		</button>
	);
}
