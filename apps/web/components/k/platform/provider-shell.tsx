// Provider card (modern interface), server side: fetches the encrypted
// credentials like the classic version.
import { ProviderSpec } from "@schema";
import { fetchDecryptedSecrets, SyncProvidersRow } from "@/lib/actions/dashboard";
import { providerSecrets } from "@db";
import { KProviderCard } from "@/components/k/platform/providers";

export default async function KProviderShell({
	userProviders,
	provisioned,
	spec,
}: {
	userProviders: SyncProvidersRow[];
	provisioned: boolean;
	spec: ProviderSpec;
}) {
	const userProvider = userProviders.find((p) => p.type === spec.key);
	if (!userProvider) {
		return (
			<div className="rounded-k-pane border border-dashed border-k-line-strong p-5 text-[13px] text-k-ink-3">
				Provider {spec.name} not found.
			</div>
		);
	}
	const [decryptedSecret] = await fetchDecryptedSecrets({
		linkTable: providerSecrets,
		foreignCol: providerSecrets.providerId,
		secretIdCol: providerSecrets.secretId,
		parentId: String(userProvider.id),
	});
	return (
		<KProviderCard
			spec={spec}
			userProvider={userProvider}
			decryptedSecret={decryptedSecret}
			provisioned={provisioned}
		/>
	);
}
