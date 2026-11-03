// ss2i : page Fournisseurs (nouvelle interface), memes donnees que la classique.
import * as React from "react";
import { PROVIDERS } from "@schema";
import { fetchDecryptedSecrets, syncProviders } from "@/lib/actions/dashboard";
import { smtpAccountSecrets } from "@db";
import KProviderShell from "@/components/k/platform/provider-shell";
import { KSmtpSection } from "@/components/k/platform/providers";
import { KPage } from "@/components/k/platform/ui";

export default async function KProvidersPage() {
	const userProviders = await syncProviders();
	const smtpSecrets = await fetchDecryptedSecrets({
		linkTable: smtpAccountSecrets,
		foreignCol: smtpAccountSecrets.accountId,
		secretIdCol: smtpAccountSecrets.secretId,
	});
	return (
		<KPage
			title="Fournisseurs"
			subtitle="Services d'envoi et de réception de vos messages. Identifiants chiffrés dans le coffre, jamais en clair."
		>
			<div className="grid gap-4 md:grid-cols-2">
				{PROVIDERS.map((p) => (
					<KProviderShell key={p.key} provisioned={false} spec={p} userProviders={userProviders} />
				))}
			</div>
			<KSmtpSection smtpSecrets={smtpSecrets} />
		</KPage>
	);
}
