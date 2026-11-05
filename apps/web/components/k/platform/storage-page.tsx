// Storage page (modern interface), same data as the classic interface.
import * as React from "react";
import { ProviderLabels, STORAGE_PROVIDERS } from "@schema";
import { fetchDecryptedSecrets, getProviderById, syncProviders } from "@/lib/actions/dashboard";
import { getWorkspacePublicId, rlsClient } from "@/lib/actions/clients";
import { driveVolumes, providerSecrets, smtpAccountSecrets } from "@db";
import { parseSecret } from "@/lib/utils";
import KProviderShell from "@/components/k/platform/provider-shell";
import KVolumes from "@/components/k/platform/volumes";
import { KPage } from "@/components/k/platform/ui";

export default async function KStoragePage() {
	const userProviders = await syncProviders();
	const rls = await rlsClient();
	const workspacePublicId = await getWorkspacePublicId();
	const vols = await rls((tx) => tx.select().from(driveVolumes));
	const [, userProviderAccounts] = await Promise.all([
		fetchDecryptedSecrets({
			linkTable: smtpAccountSecrets,
			foreignCol: smtpAccountSecrets.accountId,
			secretIdCol: smtpAccountSecrets.secretId,
		}),
		fetchDecryptedSecrets({
			linkTable: providerSecrets,
			foreignCol: providerSecrets.providerId,
			secretIdCol: providerSecrets.secretId,
		}),
	]);

	const options = [];
	for (const providerAccount of userProviderAccounts) {
		const secret = parseSecret(providerAccount);
		if (secret.verified) {
			const provider = await getProviderById(String(providerAccount.linkRow.providerId));
			const providerName = ProviderLabels[provider?.type || "unknown"] || "Unknown Provider";
			if (provider) {
				options.push({ label: providerName, value: String(providerAccount.providerId) });
			}
		}
	}

	return (
		<KPage
			title="Storage"
			subtitle="Storage providers and volumes available in the Drive."
		>
			<div className="grid gap-4 md:grid-cols-2">
				{STORAGE_PROVIDERS.map((p) => (
					<KProviderShell key={p.key} provisioned={true} spec={p} userProviders={userProviders} />
				))}
			</div>
			<KVolumes
				userProviders={userProviders}
				workspacePublicId={workspacePublicId}
				volumes={vols}
				provisioned={true}
				providerSelectOptions={options}
			/>
		</KPage>
	);
}
