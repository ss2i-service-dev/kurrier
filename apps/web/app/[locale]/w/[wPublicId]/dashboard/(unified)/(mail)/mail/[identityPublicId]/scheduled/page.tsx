import React from "react";
import ScheduledList from "@/components/mailbox/default/scheduled-list";
import { fetchScheduledDrafts } from "@/lib/actions/mailbox";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import { KSectionHeader } from "@/components/k/section";

async function ClassicPage(props: {
	params: Promise<{ identityPublicId: string; mailboxSlug: string }>;
}) {
	const { identityPublicId } = await props.params;
	const scheduledDrafts = await fetchScheduledDrafts(identityPublicId);
	return (
		<>
			<div className="p-4">
				<ul role="list" className="divide-y rounded-4xl">
					<ScheduledList drafts={scheduledDrafts} />
				</ul>
			</div>
		</>
	);
}

// ss2i : nouvelle interface (option par utilisateur) : liste dans le style de la messagerie.
async function NouvellePage(props: {
	params: Promise<{ identityPublicId: string; mailboxSlug: string }>;
}) {
	const { identityPublicId } = await props.params;
	const scheduledDrafts = await fetchScheduledDrafts(identityPublicId);
	const n = scheduledDrafts.filter((d) => String(d.status) === "scheduled").length;
	return (
		<div className="flex min-h-0 w-full max-w-4xl flex-1 flex-col">
			<KSectionHeader
				title="Envois programmés"
				subtitle={n === 0 ? "Aucun envoi programmé" : `${n} message${n > 1 ? "s" : ""} en attente d'envoi`}
			/>
			<ScheduledList drafts={scheduledDrafts} />
		</div>
	);
}

async function Page(props: { params: Promise<{ identityPublicId: string; mailboxSlug: string }> }) {
	return (await isNouvelleInterface()) ? <NouvellePage {...props} /> : <ClassicPage {...props} />;
}

export default Page;
