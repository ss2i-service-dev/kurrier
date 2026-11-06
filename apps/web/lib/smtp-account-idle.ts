// ss2i (OI 10346) : fonction sans base ni Redis (testee par test/smtp-account-idle.ts).
// Le worker suspend la synchro IMAP d'une identite dont le mot de passe est refuse (3 LOGIN
// refuses, 6 h) ; seul un imap:start-idle explicite leve la suspension avant l'echeance.
// Enregistrer un compte SMTP/IMAP (mot de passe corrige) met donc un imap:start-idle en file pour
// chaque identite qui l'utilise. Un echec de mise en file n'annule pas l'enregistrement du
// compte, deja fait : il est journalise et les autres identites sont relancees quand meme.
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
