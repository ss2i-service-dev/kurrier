// ss2i : page Identites (nouvelle interface), memes donnees que la classique.
import React from "react";
import KIdentities from "@/components/k/platform/identities";
import { fetchDecryptedSecrets, fetchUserIdentities, getProviderById } from "@/lib/actions/dashboard";
import { smtpAccountSecrets, providerSecrets } from "@db";
import { ProviderLabels } from "@schema";
import { parseSecret } from "@/lib/utils";
import { fetchWorkspace, fetchWorkspaceMembers, workspaceIdentityAssignments } from "@/lib/actions/workspace";
import { KPage } from "@/components/k/platform/ui";

export default async function KIdentitiesPage() {
	const [userSmtpAccounts, userProviderAccounts] = await Promise.all([
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
	const userIdentities = await fetchUserIdentities();

	const options = [];
	for (const providerAccount of userProviderAccounts) {
		const secret = parseSecret(providerAccount);
		if (secret.verified) {
			const provider = await getProviderById(String(providerAccount.linkRow.providerId));
			const providerName = ProviderLabels[provider?.type || "unknown"] || "Unknown Provider";
			if (provider) {
				options.push({ label: providerName, value: `provider-${String(providerAccount.linkRow.id)}` });
			}
		}
	}
	for (const smtpAccount of userSmtpAccounts) {
		const secret = parseSecret(smtpAccount);
		if (secret.sendVerified || secret.receiveVerified) {
			options.push({ label: `Compte SMTP (${secret.label})`, value: `smtp-${String(smtpAccount.linkRow.id)}` });
		}
	}

	const workspace = await fetchWorkspace();
	const workspaceMembers = await fetchWorkspaceMembers(workspace?.id);
	const workspaceUserIdentities = await workspaceIdentityAssignments();

	return (
		<KPage
			title="Identités"
			subtitle="Domaines et adresses e-mail pour envoyer et recevoir, via Amazon SES, Postmark, SendGrid, Mailgun ou SMTP."
		>
			<KIdentities
				userIdentities={userIdentities}
				smtpAccounts={userSmtpAccounts}
				providerAccounts={userProviderAccounts}
				providerOptions={options}
				workspace={workspace}
				workspaceMembers={workspaceMembers}
				workspaceUserIdentities={workspaceUserIdentities}
			/>
		</KPage>
	);
}
