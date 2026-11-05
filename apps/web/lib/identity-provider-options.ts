// Pure function (tested by test/identity-provider-options.ts, without database or alias).
// After upstream 8189d986 (#651), without the Google part: this fork has no Google OAuth, the options are
// "provider-<id>" and "smtp-<id>". An SMTP account whose address is already used by an identity (or by another
// SMTP account of the list) is no longer offered.
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
