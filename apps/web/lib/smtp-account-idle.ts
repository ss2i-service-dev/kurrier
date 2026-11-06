// Function without database or Redis (tested by test/smtp-account-idle.ts).
// The worker suspends the IMAP sync of an identity whose password is refused (3 refused LOGIN, 6 h); only an
// explicit imap:start-idle lifts the suspension before its deadline. Saving an SMTP/IMAP account (corrected
// password) therefore queues an imap:start-idle for each identity that uses it. A queueing failure does not
// cancel the saving of the account, already done: it is logged and the other identities are restarted anyway.
export async function restartIdleForSmtpAccount(
	accountId: string,
	deps: {
		identityIdsOf: (accountId: string) => Promise<string[]>;
		enqueueStartIdle: (identityId: string) => Promise<unknown>;
	},
): Promise<string[]> {
	const restarted: string[] = [];
	for (const identityId of await deps.identityIdsOf(accountId)) {
		try {
			await deps.enqueueStartIdle(identityId);
			restarted.push(identityId);
		} catch (err) {
			console.error(`imap:start-idle not queued for identity ${identityId}`, err);
		}
	}
	return restarted;
}
