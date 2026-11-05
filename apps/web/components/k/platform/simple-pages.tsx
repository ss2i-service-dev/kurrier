// API keys, Webhooks and Sync services pages (modern interface).
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
		<KPage title="API keys" subtitle="Create and manage server-to-server access keys.">
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
		<KPage title="Webhooks" subtitle="Real-time notifications when new messages arrive.">
			<KWebhooks hooksList={webhooksList} identitiesOptions={identitiesOptions} />
		</KPage>
	);
}

export async function KSyncServicesPage() {
	const { DAV_URL } = getPublicEnv();
	const account = await fetchUserDavAccountForWorkspace();
	return (
		<KPage
			title="Sync services"
			subtitle="Sync calendar and contacts through CalDAV and CardDAV."
		>
			<KSyncServices baseDavUrl={DAV_URL} username={account?.username ?? ""} password={account?.password ?? ""} />
		</KPage>
	);
}
