// Content pane (rounded white surface) for full-width screens.
import React from "react";

export default function KPane({ children, scroll = true }: { children: React.ReactNode; scroll?: boolean }) {
	return (
		<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-k-surface md:rounded-k-pane md:shadow-k-pane">
			{scroll ? <div className="k-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div> : children}
		</div>
	);
}
