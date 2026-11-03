import { fetchIdentityClients, isProIdentityPublicId } from "@/lib/actions/thread-clients";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import { getServerEnv } from "@schema";
import { crmCompanyUrl } from "@common/crm-match";
import ClientsIndex from "@/components/mailbox/default/clients-index";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";
import { KSectionHeader, KEmptyState } from "@/components/k/section";
import { Building2 } from "lucide-react";

// ss2i clients : liste complete des clients d'une identite pro, avec filtre.
async function ClassicClientsPage({ params }: { params: Promise<{ identityPublicId: string }> }) {
	const { identityPublicId } = await params;
	const workspacePublicId = await getWorkspacePublicId();
	if (!(await isProIdentityPublicId(identityPublicId))) {
		return <div className="p-4 text-sm text-muted-foreground">Clients are only available on professional mailboxes.</div>;
	}
	const all = await fetchIdentityClients();
	const entry = all.find((e) => e.identityPublicId === identityPublicId);
	const { CRM_URL } = getServerEnv();
	const clients = (entry?.clients ?? []).map((c) => ({ ...c, crmUrl: crmCompanyUrl(CRM_URL, c.companyId) }));

	return (
		<div className="p-4 space-y-4">
			<header className="flex items-center justify-between">
				<h1 className="text-lg font-semibold">Clients</h1>
				<div className="text-sm text-muted-foreground">Clients: {clients.length}</div>
			</header>
			<ClientsIndex clients={clients} identityPublicId={identityPublicId} workspacePublicId={workspacePublicId} />
		</div>
	);
}

// ss2i : nouvelle interface (option par utilisateur), memes donnees, autre presentation.
async function NouvelleClientsPage({ params }: { params: Promise<{ identityPublicId: string }> }) {
	const { identityPublicId } = await params;
	const workspacePublicId = await getWorkspacePublicId();
	if (!(await isProIdentityPublicId(identityPublicId))) {
		return (
			<KEmptyState
				icon={<Building2 size={22} strokeWidth={1.6} />}
				title="Clients indisponibles"
				text="Les clients ne sont disponibles que sur les boîtes professionnelles."
			/>
		);
	}
	const all = await fetchIdentityClients();
	const entry = all.find((e) => e.identityPublicId === identityPublicId);
	const { CRM_URL } = getServerEnv();
	const clients = (entry?.clients ?? []).map((c) => ({ ...c, crmUrl: crmCompanyUrl(CRM_URL, c.companyId) }));
	return (
		<div className="flex min-h-0 w-full max-w-4xl flex-1 flex-col">
			<KSectionHeader
				title="Clients"
				subtitle={`${clients.length} client${clients.length > 1 ? "s" : ""} rattaché${clients.length > 1 ? "s" : ""} à cette boîte`}
			/>
			<ClientsIndex clients={clients} identityPublicId={identityPublicId} workspacePublicId={workspacePublicId} />
		</div>
	);
}

export default async function ClientsPage(props: { params: Promise<{ identityPublicId: string }> }) {
	return (await isNouvelleInterface()) ? <NouvelleClientsPage {...props} /> : <ClassicClientsPage {...props} />;
}
