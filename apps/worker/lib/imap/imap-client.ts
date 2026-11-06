import { db, decryptAdminSecrets, identities, smtpAccountSecrets } from "@db";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";

const retryCounts = new Map<string, number>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const MAX_RETRIES = 5;
const BASE_DELAY = 5000;

// Consecutive authentication failures per identity, all clients combined (after canAttemptImapConnection of
// upstream 9b34ee91). Some IMAP servers ban the source IP after a number of authentication failures per day,
// all mailboxes combined (Stalwart: 100): a refused password, retried at each imap:realtime-recovery sweep (144
// times a day), would cut IMAP off for every mailbox. Beyond MAX_AUTH_FAILURES, no client of the identity (IDLE,
// commands, catch-up, safeReconnect) attempts a LOGIN for AUTH_SUSPENSION_MS since the last failure, except after an
// explicit imap:start-idle (password change); when the suspension expires, the first opening tries a LOGIN again (in
// practice the sweep), at most 3 + 4 failures per day and per identity. An endless suspension silently cut the sync
// of a mailbox nobody opens.
// Any other failure (unreachable server, disconnection, transient refusal) interrupts the series.
const MAX_AUTH_FAILURES = 3;
const AUTH_SUSPENSION_MS = 6 * 60 * 60 * 1000;
const authFailures = new Map<string, { count: number; at: number }>();

// Clock of the authentication failures, replaced by the test imap-idle-reconnect.ts.
export const imapClientDeps = {
	now: () => Date.now(),
};

// ImapFlow sets authenticationFailed on any NO or BAD answer to LOGIN (commands/login.js, authenticate.js),
// transient refusals included: Stalwart answers [CONTACTADMIN] while its storage does not answer, [LIMIT] beyond
// the simultaneous connections of the account. Only refusals of the credentials count: NO without a code
// (Microsoft 365) or with a credentials code of RFC 5530 ([AUTHENTICATIONFAILED] from Stalwart and Gmail for a
// wrong password).
const CREDENTIAL_RESPONSE_CODES = new Set([
	"AUTHENTICATIONFAILED",
	"AUTHORIZATIONFAILED",
	"EXPIRED",
]);

const isCredentialRefusal = (err: unknown) => {
	const e = err as {
		authenticationFailed?: boolean;
		responseStatus?: string;
		serverResponseCode?: string;
	} | null;
	return (
		e?.authenticationFailed === true &&
		e.responseStatus === "NO" &&
		(!e.serverResponseCode || CREDENTIAL_RESPONSE_CODES.has(e.serverResponseCode))
	);
};

export const imapAuthSuspended = (identityId: string) => {
	const failures = authFailures.get(identityId);
	return (
		!!failures &&
		failures.count >= MAX_AUTH_FAILURES &&
		imapClientDeps.now() - failures.at < AUTH_SUSPENSION_MS
	);
};

export const resetImapAuthFailures = (identityId: string) => {
	authFailures.delete(identityId);
};

// Opening in progress, per client table and per identity (after pendingConnections of upstream 5707ed41). The
// IDLE catch-up (deltaFetch, outside the BullMQ queue), the jobs and safeReconnect could open two command clients
// at the same time: the second stayed open and, when it closed, its safeReconnect disconnected the active client.
const pendingConnections = new WeakMap<
	Map<string, ImapFlow>,
	Map<string, Promise<ImapFlow | undefined>>
>();

function safeReconnect(
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
) {
	const currentRetries = retryCounts.get(identityId) ?? 0;

	if (currentRetries >= MAX_RETRIES) {
		console.error(`[IMAP:${identityId}] Max retries reached. Cooling down.`);
		return;
	}

	const delay = BASE_DELAY * (currentRetries + 1);
	retryCounts.set(identityId, currentRetries + 1);

	const existing = imapInstances.get(identityId);
	if (existing) {
		try {
			existing.removeAllListeners();
			existing.logout().catch(() => {});
		} catch {}
		imapInstances.delete(identityId);
	}

	if (reconnectTimers.has(identityId)) {
		clearTimeout(reconnectTimers.get(identityId)!);
	}

	const timer = setTimeout(() => {
		reconnectTimers.delete(identityId);
		initSmtpClient(identityId, imapInstances).catch(console.error);
	}, delay);

	reconnectTimers.set(identityId, timer);
}

export const initSmtpClient = (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
	// false for the IDLE client, which imap-idle-sync.ts reconnects itself (scheduleReconnect, imap:realtime-recovery
	// sweep); safeReconnect used to open a second one in parallel, without IDLE, which could take the place of the
	// right one in the table.
	{ reconnect = true }: { reconnect?: boolean } = {},
): Promise<ImapFlow | undefined> => {
	const existing = imapInstances.get(identityId);
	if (existing?.authenticated && existing?.usable) {
		return Promise.resolve(existing);
	}

	let pending = pendingConnections.get(imapInstances);
	if (!pending) {
		pending = new Map();
		pendingConnections.set(imapInstances, pending);
	}

	const current = pending.get(identityId);
	if (current) {
		return current;
	}

	const connection = openImapClient(identityId, imapInstances, reconnect);
	pending.set(identityId, connection);
	void connection
		.finally(() => {
			if (pending.get(identityId) === connection) {
				pending.delete(identityId);
			}
		})
		.catch(() => {});

	return connection;
};

const openImapClient = async (
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
	reconnect: boolean,
): Promise<ImapFlow | undefined> => {
	const retry = () => {
		if (reconnect) safeReconnect(identityId, imapInstances);
	};

	try {
		const existing = imapInstances.get(identityId);
		if (existing && existing.authenticated && existing.usable) {
			return existing;
		}

		if (existing) {
			try {
				existing.removeAllListeners();
				existing.logout().catch(() => {});
			} catch {}
			imapInstances.delete(identityId);
		}
	} catch (err) {
		console.error(`[IMAP:${identityId}] Existing instance check failed`, err);
		retry();
		return;
	}

	// Refused password, no more LOGIN whatever the client (IDLE, commands, catch-up, safeReconnect, queue jobs): the cap
	// used to apply to IDLE only and the other clients made ~30 failures per day and per identity again (Stalwart bans
	// the source IP at 100). Immediate failure, without counting a new failure or scheduling a reconnection; callers
	// treat the absence of a client as a connection that failed. The suspension ends at the 6 h deadline or by
	// imap:start-idle (reset before opening, startRealtimeForIdentity).
	if (imapAuthSuspended(identityId)) {
		console.warn(
			`[IMAP:${identityId}] LOGIN skipped: authentication refused, suspended until the ` +
			"6 h deadline or imap:start-idle",
		);
		return;
	}

	try {
		const [identity] = await db
			.select()
			.from(identities)
			.where(eq(identities.id, identityId));

		if (!identity || !identity.smtpAccountId) {
			return;
		}

		const [secrets] = await decryptAdminSecrets({
			linkTable: smtpAccountSecrets,
			foreignCol: smtpAccountSecrets.accountId,
			secretIdCol: smtpAccountSecrets.secretId,
			ownerId: identity.ownerId,
			parentId: String(identity.smtpAccountId),
		});

		const credentials = secrets?.vault?.decrypted_secret
			? JSON.parse(secrets.vault.decrypted_secret)
			: {};

		const client = new ImapFlow({
			host: credentials.IMAP_HOST,
			port: credentials.IMAP_PORT,
			secure:
				credentials.IMAP_SECURE === "true" || credentials.IMAP_SECURE === true,
			auth: {
				user: credentials.IMAP_USERNAME,
				pass: credentials.IMAP_PASSWORD,
			},
			// 5 min rather than 60 s: Gmail throttles the stream heavily when approaching its
			// daily quota, and with 60 s backfill batches were cut off midway.
			socketTimeout: 300_000,
			logger: {
				error(data: any) {
					console.error(`[IMAP:${identityId}]`, data.msg ?? data);
				},
				warn() {},
				info() {},
				debug() {},
			},
			logRaw: false,
		});

		// A disconnection during LOGIN makes the client emit 'error' (Connection not available) before the listeners
		// below are set: uncaughtException. The rejection of connect() is enough to handle the failure; the listener
		// stays on a refused client.
		const ignoreConnectError = () => {};
		client.on("error", ignoreConnectError);

		try {
			await client.connect();
			client.off("error", ignoreConnectError);
			retryCounts.set(identityId, 0);
			authFailures.delete(identityId);
		} catch (err) {
			console.error(`[IMAP:${identityId}] connect() failed:`, err);
			if (isCredentialRefusal(err)) {
				authFailures.set(identityId, {
					count: (authFailures.get(identityId)?.count ?? 0) + 1,
					at: imapClientDeps.now(),
				});
			} else {
				authFailures.delete(identityId);
			}
			// After a refused LOGIN, ImapFlow keeps the connection open until socketTimeout (5 min), then emits an error
			// nobody listens to anymore.
			try {
				client.close();
			} catch {}
			retry();
			return;
		}

		imapInstances.set(identityId, client);

		const noopInterval = setInterval(async () => {
			try {
				if (client.usable) {
					await client.noop();
				} else {
					throw new Error("Client not usable");
				}
			} catch (err) {
				clearInterval(noopInterval);
				// IDLE client already closed (shutdown, replacement): nothing to do.
				if (!reconnect && !client.usable) return;
				console.error(`[IMAP:${identityId}] NOOP failed:`, err);
				if (reconnect) safeReconnect(identityId, imapInstances);
				else client.close();
			}
		}, 5 * 60 * 1000);

		const cleanup = (reason: string) => {
			clearInterval(noopInterval);
			try {
				client.removeAllListeners();
				client.logout().catch(() => {});
			} catch {}
			// Only remove this client, a more recent one may have replaced it.
			if (imapInstances.get(identityId) === client) imapInstances.delete(identityId);
			console.warn(`[IMAP:${identityId}] Disconnected (${reason})`);
			retry();
		};

		client.once("close", () => cleanup("close"));
		client.once("error", (err) => {
			console.error(`[IMAP:${identityId}] Error:`, err);
			cleanup("error");
		});

		return client;
	} catch (err) {
		console.error(`[IMAP:${identityId}] init failed`, err);
		retry();
		return;
	}
};
