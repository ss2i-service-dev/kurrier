// ss2i : pages Cles d'API, Webhooks et Services de synchronisation (nouvelle interface).
import React from "react";
import { fetchUserAPIKeys, fetchUserDavAccountForWorkspace, fetchUserWebhooks } from "@/lib/actions/dashboard";
import { fetchIdentityMailboxList } from "@/lib/actions/mailbox";
import { getPublicEnv } from "@schema";
import { KPage } from "@/components/k/platform/ui";
import KApiKeys from "@/components/k/platform/api-keys";
import KWebhooks from "@/components/k/platform/webhooks";
import KSyncServices from "@/components/k/platform/sync-services";

export async function KApiKeysPage() {
	const apiKeysList = await fetchUserAPIKeys();
	return (
		<KPage title="Clés d'API" subtitle="Créez et gérez les clés d'accès de serveur à serveur.">
			<KApiKeys apiKeysList={apiKeysList} />
		</KPage>
	);
}

export async function KWebhooksPage() {
	const webhooksList = await fetchUserWebhooks();
	const identityMailboxes = await fetchIdentityMailboxList();
	const identitiesOptions = identityMailboxes.map((im) => ({
		label: `${im.identity.displayName} <${im.identity.value}>`,
		value: im.identity.id,
	}));
	return (
		<KPage title="Webhooks" subtitle="Notifications en temps réel à la réception de nouveaux messages.">
			<KWebhooks hooksList={webhooksList} identitiesOptions={identitiesOptions} />
		</KPage>
	);
}

export async function KSyncServicesPage() {
	const { DAV_URL } = getPublicEnv();
	const account = await fetchUserDavAccountForWorkspace();
	return (
		<KPage
			title="Services de synchronisation"
			subtitle="Synchronisez agenda et contacts via CalDAV et CardDAV."
		>
			<KSyncServices baseDavUrl={DAV_URL} username={account?.username ?? ""} password={account?.password ?? ""} />
		</KPage>
	);
}
