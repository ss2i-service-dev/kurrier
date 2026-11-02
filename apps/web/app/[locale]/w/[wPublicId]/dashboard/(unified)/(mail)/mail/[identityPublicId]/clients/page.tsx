import { fetchIdentityClients, isProIdentityPublicId } from "@/lib/actions/thread-clients";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import { getServerEnv } from "@schema";
import { crmCompanyUrl } from "@common/crm-match";
import ClientsIndex from "@/components/mailbox/default/clients-index";

// ss2i clients : liste complete des clients d'une identite pro, avec filtre.
export default async function ClientsPage({ params }: { params: Promise<{ identityPublicId: string }> }) {
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
