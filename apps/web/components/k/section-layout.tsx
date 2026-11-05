// Frame for full-width screens outside a folder (snoozed, scheduled sends):
// pane, search bar, scrolling area.
import React from "react";
import KPane from "@/components/k/pane";
import KSearchHeader from "@/components/k/search-header";

export default async function KSectionLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<Record<string, string>>;
}) {
	// Search on these screens targets the identity's inbox.
	const withSlug = params.then((p) => ({ ...p, mailboxSlug: "inbox" }));
	return (
		<KPane scroll={false}>
			<KSearchHeader params={withSlug} />
			<div className="k-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
		</KPane>
	);
}
