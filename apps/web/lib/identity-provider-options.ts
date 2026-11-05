// ss2i : fonction pure (testee par test/identity-provider-options.ts, sans base ni alias).
// Repris de 8189d986 amont (#651), sans la partie Google : ce fork n'a pas d'OAuth Google,
// les options sont « provider-<id> » et « smtp-<id> ». Un compte SMTP dont l'adresse sert
// deja a une identite (ou a un autre compte SMTP de la liste) n'est plus propose.
export function availableProviderOptions<A extends { linkRow: { [key: string]: unknown } }>(
	providerOptions: { label: string; value: string }[],
	smtpAccounts: A[],
	existingIdentityValues: string[],
	usernameOf: (account: A) => string,
): { label: string; value: string }[] {
	const taken = new Set(existingIdentityValues.map((v) => v.trim().toLowerCase()));
	const seen = new Set<string>();
	return providerOptions.filter((option) => {
		if (!option.value.startsWith("smtp-")) return true;
		const id = option.value.slice("smtp-".length);
		const account = smtpAccounts.find((a) => String(a.linkRow["id"]) === id);
		if (!account) return false;
		const email = usernameOf(account).trim().toLowerCase();
		if (!email || taken.has(email) || seen.has(email)) return false;
		seen.add(email);
		return true;
	});
}
