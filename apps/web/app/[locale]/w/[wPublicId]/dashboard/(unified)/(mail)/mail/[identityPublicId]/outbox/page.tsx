import React from "react";
import OutboxList from "@/components/mailbox/default/outbox-list";
import { fetchOutbox } from "@/lib/actions/mailbox";
import { isModernUi } from "@/lib/actions/interface-pref";
import { KSectionHeader } from "@/components/k/section";
import { isOutboxCalm } from "@/lib/outbox-view";

// Outbox: sends of the identity that are waiting, in progress or failed, read from the
// draft_messages ledger. Replaces the scheduled sends page (/scheduled redirects here).
async function ClassicPage(props: { params: Promise<{ identityPublicId: string }> }) {
	const { identityPublicId } = await props.params;
	const items = await fetchOutbox(identityPublicId);
	return (
		<div className="p-4">
			<OutboxList items={items} />
		</div>
	);
}

// Modern interface (per-user option): list in the mail style.
async function ModernPage(props: { params: Promise<{ identityPublicId: string }> }) {
	const { identityPublicId } = await props.params;
	const items = await fetchOutbox(identityPublicId);
	const n = items.length;
	const alerts = items.filter((i) => !isOutboxCalm(i.state)).length;
	const subtitle =
		n === 0
			? "Nothing waiting to be sent"
			: `${n} message${n > 1 ? "s" : ""}${alerts > 0 ? `, ${alerts} not sent` : ""}`;
	return (
		<div className="flex min-h-0 w-full max-w-4xl flex-1 flex-col">
			<KSectionHeader title="Outbox" subtitle={subtitle} />
			<OutboxList items={items} />
		</div>
	);
}

async function Page(props: { params: Promise<{ identityPublicId: string }> }) {
	return (await isModernUi()) ? <ModernPage {...props} /> : <ClassicPage {...props} />;
}

export default Page;
