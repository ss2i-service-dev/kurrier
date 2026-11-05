import { db, identities, mailboxes, mailboxThreads, messages } from "@db";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { imapAuthSuspended, initSmtpClient, resetImapAuthFailures } from "./imap-client";
import type { FlagsEvent, ImapFlow } from "imapflow";
import { deltaFetch } from "../../lib/imap/imap-delta-fetch";

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFFS_MS = [5000, 10000, 20000, 40000, 80000];
// Duration beyond which an IDLE connection is judged healthy and resets the reconnection counter when it
// drops. Resetting it as soon as the INBOX lock is taken made a server that accepts the connection then cuts it
// reconnect every 5 s, endlessly.
const HEALTHY_CONNECTION_MS = 60_000;

const reconnectAttempts = new Map<string, number>();
const reconnectTimers = new Map<string, unknown>();
const stoppedIdentities = new Set<string>();
// Opening in progress. The imap:start-idle job, the startup sync, the imap:realtime-recovery sweep and a
// scheduled reconnection can target the same identity at the same time: without this guard, each one opened its
// own connection and two IDLE ran.
const startingIdentities = new Set<string>();

// Opening of the IDLE client, timers, clock and deltaFetch, the only points that the tests
// apps/worker/test/imap-idle-*.ts replace (fake ImapFlow, simulated clock).
// reconnect: false: this module reconnects the IDLE client, not safeReconnect.
export const realtimeDeps = {
	openClient: (identityId: string, idleImapInstances: Map<string, ImapFlow>) =>
		initSmtpClient(identityId, idleImapInstances, { reconnect: false }),
	setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
	clearTimeout: (timer: unknown) => clearTimeout(timer as NodeJS.Timeout),
	now: () => Date.now(),
	deltaFetch: (identityId: string, imapInstances: Map<string, ImapFlow>) =>
		deltaFetch(identityId, imapInstances),
};

let realtimeShuttingDown = false;

async function handleFlagsUpdate(
	identityId: string,
	uid: number,
	mailboxPath: string,
	isFlagged: boolean,
	isSeen: boolean,
	isAnswered: boolean,
) {
	console.log(
		`[realtime:${identityId}] handleFlagsUpdate uid=${uid} mailboxPath=${mailboxPath} flagged=${isFlagged} seen=${isSeen}`,
	);

	await db.transaction(async (tx) => {
		const [mailbox] = await tx
			.select()
			.from(mailboxes)
			.where(
				and(
					eq(mailboxes.identityId, identityId),
					sql`${mailboxes.metaData} -> 'imap' ->> 'path' = ${mailboxPath}`,
				),
			);

		if (!mailbox) {
			console.warn(
				`[realtime:${identityId}] could not find mailbox for path=${mailboxPath}`,
			);
			return;
		}

		const [message] = await tx
			.select()
			.from(messages)
			.where(
				and(
					eq(messages.mailboxId, mailbox.id),
					sql`(${messages.metaData} -> 'imap' ->> 'uid')::bigint = ${uid}`,
				),
			);

		if (!message) {
			console.warn(
				`[realtime:${identityId}] could not find message for uid=${uid} in mailboxId=${mailbox.id}`,
			);
			return;
		}

		if (
			message.flagged === isFlagged &&
			message.seen === isSeen &&
			message.answered === isAnswered
		) {
			return;
		}

		const now = new Date();

		await tx
			.update(messages)
			.set({
				flagged: isFlagged,
				seen: isSeen,
				answered: isAnswered,
				updatedAt: now,
			})
			.where(eq(messages.id, message.id));

		const [agg] = await tx
			.select({
				unreadCount: sql<number>`
					count(*) filter (where ${messages.seen} = false)
				`,
				anyFlagged: sql<boolean>`
					bool_or(${messages.flagged})
				`,
			})
			.from(messages)
			.where(
				and(
					eq(messages.threadId, message.threadId),
					eq(messages.mailboxId, mailbox.id),
				),
			);

		await tx
			.update(mailboxThreads)
			.set({
				unreadCount: Number(agg?.unreadCount ?? 0),
				starred: Boolean(agg?.anyFlagged ?? false),
				updatedAt: now,
			})
			.where(
				and(
					eq(mailboxThreads.threadId, message.threadId),
					eq(mailboxThreads.mailboxId, mailbox.id),
				),
			);
	});
}

async function handleExpunge(
	identityId: string,
	mailboxPath: string,
	uid: number,
) {
	console.log(
		`[realtime:${identityId}] handleExpunge mailboxPath=${mailboxPath} uid=${uid}`,
	);

	await db.transaction(async (tx) => {
		const [mailbox] = await tx
			.select()
			.from(mailboxes)
			.where(
				and(
					eq(mailboxes.identityId, identityId),
					sql`${mailboxes.metaData} -> 'imap' ->> 'path' = ${mailboxPath}`,
				),
			);

		if (!mailbox) {
			console.warn(
				`[realtime:${identityId}] expunge: no mailbox for path=${mailboxPath}`,
			);
			return;
		}

		const [message] = await tx
			.select()
			.from(messages)
			.where(
				and(
					eq(messages.mailboxId, mailbox.id),
					sql`(${messages.metaData} -> 'imap' ->> 'uid')::bigint = ${uid}`,
				),
			);

		if (!message) {
			console.warn(
				`[realtime:${identityId}] expunge: no message for uid=${uid} in mailbox=${mailbox.id}`,
			);
			return;
		}

		await tx
			.delete(messages)
			.where(eq(messages.id, message.id));

		const [agg] = await tx
			.select({
				unreadCount: sql<number>`
					count(*) filter (where ${messages.seen} = false)
				`,
				anyFlagged: sql<boolean>`
					bool_or(${messages.flagged})
				`,
				messageCount: sql<number>`
					count(*)
				`,
			})
			.from(messages)
			.where(
				and(
					eq(messages.threadId, message.threadId),
					eq(messages.mailboxId, mailbox.id),
				),
			);

		const remainingCount = Number(agg?.messageCount ?? 0);

		if (remainingCount === 0) {
			await tx
				.delete(mailboxThreads)
				.where(
					and(
						eq(mailboxThreads.threadId, message.threadId),
						eq(mailboxThreads.mailboxId, mailbox.id),
					),
				);
		} else {
			await tx
				.update(mailboxThreads)
				.set({
					unreadCount: Number(agg?.unreadCount ?? 0),
					starred: Boolean(agg?.anyFlagged ?? false),
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(mailboxThreads.threadId, message.threadId),
						eq(mailboxThreads.mailboxId, mailbox.id),
					),
				);
		}
	});
}

function attachRealtimeEventHandlers(
	identityId: string,
	client: ImapFlow,
	imapInstances: Map<string, ImapFlow>,
) {
	client.on("exists", () => {
		if (realtimeShuttingDown || stoppedIdentities.has(identityId)) {
			return;
		}

		void realtimeDeps.deltaFetch(identityId, imapInstances).catch((err) => {
			console.error(
				`[realtime:${identityId}] delta fetch after EXISTS failed`,
				err,
			);
		});
	});

	client.on("flags", (ev: FlagsEvent) => {
		if (realtimeShuttingDown || stoppedIdentities.has(identityId)) {
			return;
		}

		void (async () => {
			try {
				let uid = (ev as any).uid as number | undefined;

				if (!uid) {
					const msg = await client.fetchOne(ev.seq, {
						uid: true,
					});

					if (msg) {
						uid = msg.uid;
					}
				}

				if (!uid) {
					console.warn(
						`[realtime:${identityId}] could not resolve UID for seq=${ev.seq}`,
					);
					return;
				}

				await handleFlagsUpdate(
					identityId,
					uid,
					ev.path,
					ev.flags.has("\\Flagged"),
					ev.flags.has("\\Seen"),
					ev.flags.has("\\Answered"),
				);
			} catch (err) {
				if (!realtimeShuttingDown) {
					console.error(
						`[realtime:${identityId}] flags handler failed`,
						err,
					);
				}
			}
		})();
	});

	client.on("expunge", (ev) => {
		if (realtimeShuttingDown || stoppedIdentities.has(identityId)) {
			return;
		}

		void (async () => {
			try {
				const uid = (ev as any).uid as number | undefined;

				if (!uid) {
					console.warn(
						`[realtime:${identityId}] expunge: missing uid for seq=${ev.seq}`,
					);
					return;
				}

				await handleExpunge(
					identityId,
					ev.path,
					uid,
				);
			} catch (err) {
				if (!realtimeShuttingDown) {
					console.error(
						`[realtime:${identityId}] expunge handler failed`,
						err,
					);
				}
			}
		})();
	});
}

function clearReconnectTimer(identityId: string) {
	const timer = reconnectTimers.get(identityId);

	if (timer) {
		realtimeDeps.clearTimeout(timer);
		reconnectTimers.delete(identityId);
	}
}

function scheduleReconnect(
	identityId: string,
	idleImapInstances: Map<string, ImapFlow>,
	imapInstances: Map<string, ImapFlow>,
) {
	if (realtimeShuttingDown) {
		return;
	}

	if (stoppedIdentities.has(identityId)) {
		return;
	}

	if (reconnectTimers.has(identityId)) {
		return;
	}

	// Password refused, do not retry alone (Stalwart bans the source IP); the sweep retries once the suspension
	// has expired (6 h).
	if (imapAuthSuspended(identityId)) {
		console.error(
			`[realtime:${identityId}] IMAP authentication refused; automatic reconnect suspended ` +
			"for 6 h, or until a successful connection or imap:start-idle",
		);
		return;
	}

	const attempts = reconnectAttempts.get(identityId) ?? 0;

	if (attempts >= MAX_RECONNECT_ATTEMPTS) {
		console.error(
			`[realtime:${identityId}] reconnect cap reached; stopping automatic reconnect`,
		);
		return;
	}

	const backoffMs =
		RECONNECT_BACKOFFS_MS[
			Math.min(
				attempts,
				RECONNECT_BACKOFFS_MS.length - 1,
			)
			];

	reconnectAttempts.set(identityId, attempts + 1);

	console.warn(
		`[realtime:${identityId}] reconnecting in ${backoffMs / 1000}s ` +
		`(attempt ${attempts + 1}/${MAX_RECONNECT_ATTEMPTS})`,
	);

	const timer = realtimeDeps.setTimeout(() => {
		reconnectTimers.delete(identityId);

		if (
			realtimeShuttingDown ||
			stoppedIdentities.has(identityId)
		) {
			return;
		}

		void startRealtimeForIdentity(
			identityId,
			idleImapInstances,
			imapInstances,
			true,
		).catch((err) => {
			console.error(
				`[realtime:${identityId}] reconnect attempt failed`,
				err,
			);

			scheduleReconnect(
				identityId,
				idleImapInstances,
				imapInstances,
			);
		});
	}, backoffMs);

	reconnectTimers.set(identityId, timer);
}

async function idleForever(
	identityId: string,
	client: ImapFlow,
): Promise<void> {
	console.log(
		`[realtime:${identityId}] entering idle loop`,
	);

	const shouldContinue = () =>
		!realtimeShuttingDown &&
		!stoppedIdentities.has(identityId) &&
		client.authenticated &&
		client.usable;

	while (shouldContinue()) {
		try {
			await client.idle();

			if (!shouldContinue()) {
				break;
			}

			// ImapFlow can resolve immediately when already idling.
			// Always yield to timers and I/O before trying again.
			await new Promise<void>((resolve) => {
				realtimeDeps.setTimeout(resolve, 1_000);
			});
		} catch (err) {
			if (
				!realtimeShuttingDown &&
				!stoppedIdentities.has(identityId)
			) {
				console.error(
					`[realtime:${identityId}] IDLE failed`,
					err,
				);
			}

			break;
		}
	}

	console.warn(
		`[realtime:${identityId}] idle loop ended`,
	);
}

async function startRealtimeSyncForIdentity(
	identityId: string,
	client: ImapFlow,
	idleImapInstances: Map<string, ImapFlow>,
	imapInstances: Map<string, ImapFlow>,
) {
	let lock: Awaited<
		ReturnType<ImapFlow["getMailboxLock"]>
	> | null = null;
	let establishedAt: number | undefined;

	try {
		lock = await client.getMailboxLock("INBOX");

		if (
			realtimeShuttingDown ||
			stoppedIdentities.has(identityId)
		) {
			return;
		}

		attachRealtimeEventHandlers(
			identityId,
			client,
			imapInstances,
		);

		establishedAt = realtimeDeps.now();

		// ImapFlow does not emit exists on SELECT; what arrived during the disconnection (or while the worker was
		// restarting) was only seen at the next message.
		void realtimeDeps.deltaFetch(identityId, imapInstances).catch((err) => {
			console.error(
				`[realtime:${identityId}] catch-up delta fetch failed`,
				err,
			);
		});

		await idleForever(
			identityId,
			client,
		);
	} catch (err) {
		if (
			!realtimeShuttingDown &&
			!stoppedIdentities.has(identityId)
		) {
			console.error(
				`[realtime:${identityId}] realtime sync failed`,
				err,
			);
		}
	} finally {
		if (lock) {
			try {
				lock.release();
			} catch {}
		}

		if (idleImapInstances.get(identityId) === client) {
			idleImapInstances.delete(identityId);
		}

		/*
		 * A connection which stayed up long enough was healthy.
		 */
		if (
			establishedAt !== undefined &&
			realtimeDeps.now() - establishedAt >= HEALTHY_CONNECTION_MS
		) {
			reconnectAttempts.set(identityId, 0);
		}

		client.removeAllListeners();

		if (client.usable) {
			try {
				client.close();
			} catch {}
		}

		if (
			!realtimeShuttingDown &&
			!stoppedIdentities.has(identityId)
		) {
			scheduleReconnect(
				identityId,
				idleImapInstances,
				imapInstances,
			);
		}
	}
}

export async function startRealtimeForIdentity(
	identityId: string,
	idleImapInstances: Map<string, ImapFlow>,
	imapInstances: Map<string, ImapFlow>,
	isReconnect = false,
) {
	if (realtimeShuttingDown) {
		return;
	}

	/*
	 * An explicit start means this identity is allowed to run again.
	 * A reconnect does not alter stop/start state.
	 */
	if (!isReconnect) {
		resetImapAuthFailures(identityId);
		stoppedIdentities.delete(identityId);
		reconnectAttempts.set(identityId, 0);
		clearReconnectTimer(identityId);
	}

	if (stoppedIdentities.has(identityId)) {
		return;
	}

	const existing = idleImapInstances.get(identityId);

	if (
		existing?.authenticated &&
		existing?.usable &&
		(existing as any).__kurrierRealtimeStarted
	) {
		console.log(
			`[realtime:${identityId}] realtime already active`,
		);
		return;
	}

	if (startingIdentities.has(identityId)) {
		console.log(
			`[realtime:${identityId}] realtime start already in progress`,
		);
		return;
	}

	startingIdentities.add(identityId);

	let client: ImapFlow | undefined;

	try {
		client = await realtimeDeps.openClient(
			identityId,
			idleImapInstances,
		);
	} catch (err) {
		if (!realtimeShuttingDown) {
			console.error(
				`[realtime:${identityId}] failed to initialize IMAP client`,
				err,
			);

			scheduleReconnect(
				identityId,
				idleImapInstances,
				imapInstances,
			);
		}

		return;
	} finally {
		startingIdentities.delete(identityId);
	}

	if (
		realtimeShuttingDown ||
		stoppedIdentities.has(identityId)
	) {
		if (client) {
			try {
				client.removeAllListeners();
				client.close();
			} catch {}
		}

		return;
	}

	if (!client?.authenticated || !client?.usable) {
		console.warn(
			`[realtime:${identityId}] IMAP client not usable`,
		);

		scheduleReconnect(
			identityId,
			idleImapInstances,
			imapInstances,
		);

		return;
	}

	if ((client as any).__kurrierRealtimeStarted) {
		return;
	}

	(client as any).__kurrierRealtimeStarted = true;

	/*
	 * Do not await the lifetime of the IDLE connection.
	 */
	void startRealtimeSyncForIdentity(
		identityId,
		client,
		idleImapInstances,
		imapInstances,
	).catch((err) => {
		if (!realtimeShuttingDown) {
			console.error(
				`[realtime:${identityId}] realtime task failed`,
				err,
			);
		}
	});
}

export async function stopRealtimeForIdentity(
	identityId: string,
	idleImapInstances: Map<string, ImapFlow>,
	imapInstances: Map<string, ImapFlow>,
) {
	/*
	 * Mark stopped before touching either connection.
	 */
	stoppedIdentities.add(identityId);

	clearReconnectTimer(identityId);
	reconnectAttempts.delete(identityId);

	const idleClient = idleImapInstances.get(identityId);
	const cmdClient = imapInstances.get(identityId);

	idleImapInstances.delete(identityId);
	imapInstances.delete(identityId);

	// Without its listeners (otherwise safeReconnect would reopen), an RST from the server during LOGOUT would
	// raise an 'error' event nobody listens to.
	if (idleClient) {
		try {
			idleClient.removeAllListeners();
			idleClient.on("error", () => {});
			await idleClient.logout();
		} catch {
			try {
				idleClient.close();
			} catch {}
		}
	}

	if (cmdClient && cmdClient !== idleClient) {
		try {
			cmdClient.removeAllListeners();
			cmdClient.on("error", () => {});
			await cmdClient.logout();
		} catch {
			try {
				cmdClient.close();
			} catch {}
		}
	}

	console.log(
		`[realtime:${identityId}] stopped realtime + command IMAP clients`,
	);
}

export function beginRealtimeShutdown() {
	if (realtimeShuttingDown) {
		return;
	}

	realtimeShuttingDown = true;

	for (const timer of reconnectTimers.values()) {
		realtimeDeps.clearTimeout(timer);
	}

	reconnectTimers.clear();
	reconnectAttempts.clear();

	console.log(
		"[realtime] shutdown started; reconnects disabled",
	);
}

export const imapIdleSync = async (
	idleImapInstances: Map<string, ImapFlow>,
	imapInstances: Map<string, ImapFlow>,
) => {
	if (realtimeShuttingDown) {
		return;
	}

	const identityRows = await db
		.select()
		.from(identities)
		.where(isNotNull(identities.smtpAccountId));

	for (const identity of identityRows) {
		if (realtimeShuttingDown) {
			break;
		}

		await startRealtimeForIdentity(
			identity.id,
			idleImapInstances,
			imapInstances,
		);
	}
};

export const recoverOfflineRealtime = async (
	idleImapInstances: Map<string, ImapFlow>,
	imapInstances: Map<string, ImapFlow>,
) => {
	if (realtimeShuttingDown) {
		return;
	}

	const identityRows = await db
		.select()
		.from(identities)
		.where(isNotNull(identities.smtpAccountId));

	console.info(
		`[realtime-recovery] checking ${identityRows.length} identities`,
	);

	for (const identity of identityRows) {

		if (realtimeShuttingDown) {
			break;
		}

		const existing = idleImapInstances.get(identity.id);

		if (
			existing?.authenticated &&
			existing?.usable &&
			(existing as any).__kurrierRealtimeStarted
		) {
			continue;
		}

		// Reconnection already scheduled or opening in progress, let it run; password refused, do not retry before
		// the end of the suspension (Stalwart ban).
		if (
			reconnectTimers.has(identity.id) ||
			startingIdentities.has(identity.id) ||
			imapAuthSuspended(identity.id)
		) {
			continue;
		}

		console.info(
			`[realtime-recovery] attempting identity=${identity.id}`,
		);

		await startRealtimeForIdentity(
			identity.id,
			idleImapInstances,
			imapInstances,
			true,
		);
	}
};
