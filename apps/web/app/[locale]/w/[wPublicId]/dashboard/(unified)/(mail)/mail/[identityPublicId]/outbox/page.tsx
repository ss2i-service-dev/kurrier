import React from "react";
import OutboxList from "@/components/mailbox/default/outbox-list";
import { fetchOutbox } from "@/lib/actions/mailbox";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import { KSectionHeader } from "@/components/k/section";
import { isOutboxCalm } from "@/lib/outbox-view";

// ss2i : Boite d'envoi (OI 10519) : envois en attente, en cours et en echec de l'identite, lus
// sur le ledger draft_messages. Remplace la page des envois programmes (/scheduled y redirige).
async function ClassicPage(props: { params: Promise<{ identityPublicId: string }> }) {
	const { identityPublicId } = await props.params;
	const items = await fetchOutbox(identityPublicId);
	return (
		<div className="p-4">
			<OutboxList items={items} />
		</div>
	);
}

// ss2i : nouvelle interface (option par utilisateur) : liste dans le style de la messagerie.
async function NouvellePage(props: { params: Promise<{ identityPublicId: string }> }) {
	const { identityPublicId } = await props.params;
	const items = await fetchOutbox(identityPublicId);
	const n = items.length;
	const alerts = items.filter((i) => !isOutboxCalm(i.state)).length;
	const subtitle =
		n === 0
			? "Rien en attente d'envoi"
			: `${n} message${n > 1 ? "s" : ""}${alerts > 0 ? `, dont ${alerts} non parti${alerts > 1 ? "s" : ""}` : ""}`;
	return (
		<div className="flex min-h-0 w-full max-w-4xl flex-1 flex-col">
			<KSectionHeader title="Boîte d'envoi" subtitle={subtitle} />
			<OutboxList items={items} />
		</div>
	);
}

async function Page(props: { params: Promise<{ identityPublicId: string }> }) {
	return (await isNouvelleInterface()) ? <NouvellePage {...props} /> : <ClassicPage {...props} />;
}

export default Page;
