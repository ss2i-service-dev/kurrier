import { ImapFlow, FetchMessageObject } from "imapflow";
import {
	db,
	identities,
	IdentityEntity,
	mailboxes,
	mailboxSync,
	messages,
} from "@db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { parseAndStoreEmail } from "../../message-payload-parser";
import { initSmtpClient } from "../../../lib/imap/imap-client";
import { defaultImapQuota } from "@schema";
import dayjs from "dayjs";
import {
	davCreateCalendarForIdentity
} from "../../../lib/dav/calendar/dav-create-addressbook-calendar-for-identity";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export type IdentityQuota = {
	limit: number;
	expiresAt: string;
};

const identityQuotaMap = new Map<string, IdentityQuota>();
export function getOrInitQuota(
	identityId: string,
	dailyLimitBytes: number,
): IdentityQuota {
	const now = dayjs();
	const existing = identityQuotaMap.get(identityId);

	if (existing && now.isBefore(existing.expiresAt)) {
		return existing;
	}

	const quota: IdentityQuota = {
		limit: dailyLimitBytes,
		expiresAt: now.add(1, "day").toISOString()
	};

	identityQuotaMap.set(identityId, quota);
	return quota;
}

function getDailyQuota(identity: IdentityEntity): number {
	const meta = (identity.metaData as any) ?? {};
	const val = Number(meta.dailyQuota);
	return Number.isFinite(val) && val > 0 ? val : defaultImapQuota;
}

function mapImapFlags(flags?: string[] | Set<string>) {
	const f = Array.isArray(flags) ? flags : Array.from(flags ?? []);
	const has = (x: string) => f.some((v) => v.toLowerCase() === x.toLowerCase());

	return {
		seen: has("\\seen"),
		answered: has("\\answered"),
		flagged: has("\\flagged"),
		draft: has("\\draft"),
	};
}

type BackfillMailboxOpts = {
	client: ImapFlow;
	identityId: string;
	ownerId: string;
	workspaceId: string;
	mailboxId: string;
	path: string;
	window?: number;
	politeWaitMs?: number;
	quota: IdentityQuota;
	// Do not download a message already present in another folder of the identity.
	skipKnownMessages?: boolean;
};

const DEFAULT_WINDOW = 300;

// Value of `backfill_cursor_uid` meaning "backfill of this folder is finished". 0 alone would
// also mean "never started": a folder that reached the bottom would restart from the top on
// the next pass, and with chained windows the backfill would loop on a finished INBOX without
// ever moving on to the next folders. To replay a folder, reset its cursor to 0 (or to a UID).
const BACKFILL_DONE = -1;

async function backfillMailboxFull(opts: BackfillMailboxOpts): Promise<boolean> {
	const {
		client,
		identityId,
		ownerId,
		mailboxId,
		path,
		window = DEFAULT_WINDOW,
		politeWaitMs = 0,
		quota,
		workspaceId,
		skipKnownMessages = false,
	} = opts;

	if (quota.limit <= 0) return false;

	const box = await client.mailboxOpen(path, { readOnly: true });
	const top = Math.max(0, (box.uidNext ?? 1) - 1);

	const [sync] = await db
		.select()
		.from(mailboxSync)
		.where(
			and(
				eq(mailboxSync.identityId, identityId),
				eq(mailboxSync.mailboxId, mailboxId),
			),
		);

	if (!sync) {
		console.warn("[imap:backfill-full] mailbox_sync missing", {
			identityId,
			mailboxId,
			path,
		});
		return false;
	}

	if (!sync.lastSeenUid || Number(sync.lastSeenUid) === 0) {
		const TAIL_WINDOW = 200;
		const bootLastSeen = Math.max(0, top - TAIL_WINDOW + 1);

		await db
			.update(mailboxSync)
			.set({
				lastSeenUid: bootLastSeen,
				updatedAt: new Date(),
			})
			.where(eq(mailboxSync.id, sync.id));

		// update local copy so any later logic sees it
		sync.lastSeenUid = bootLastSeen as any;
	}

	let cursor = Number(sync.backfillCursorUid ?? 0);

	if (cursor === BACKFILL_DONE) return false;

	// Nothing left to backfill for this mailbox
	if (cursor <= 0) {
		if (top <= 0) {
			await db
				.update(mailboxSync)
				.set({
					phase: "IDLE",
					backfillCursorUid: 0,
					updatedAt: new Date(),
				})
				.where(eq(mailboxSync.id, sync.id));
			return false;
		}

		cursor = top;

		await db
			.update(mailboxSync)
			.set({
				backfillCursorUid: cursor,
				phase: "BACKFILL",
				updatedAt: new Date(),
			})
			.where(eq(mailboxSync.id, sync.id));
	}

	await db
		.update(mailboxSync)
		.set({ phase: "BACKFILL", updatedAt: new Date() })
		.where(eq(mailboxSync.id, sync.id));

	const end = cursor;
	const start = Math.max(1, end - window + 1);
	const range = `${start}:${end}`;
	console.info("[imap:backfill-full] batch range", { identityId, path, range });

	// The window is processed idempotently. Iterating `client.fetch(range)` and advancing the
	// cursor unconditionally is not safe: imapflow silently ends the iteration when the
	// connection drops (Gmail cuts it after socketTimeout when throttling), and leaving the loop
	// when the quota runs out has the same effect: the remaining UIDs of the window would be
	// skipped forever. Instead: 1) ask the server which UIDs are present in the window; 2) drop
	// those already in the database; 3) fetch only the missing ones; 4) advance the cursor only
	// if the window is complete. An incomplete window is resumed on the next pass, redoing only
	// the gaps. Corollary: resetting `backfill_cursor_uid` to the top replays the whole backfill
	// cheaply.
	let batchBytes = 0;
	let processedCount = 0;
	let complete = false;

	try {
		const searchRes = await client.search({ uid: range }, { uid: true });
		if (searchRes === false) throw new Error("UID SEARCH failed, window kept");
		const present = (searchRes || []) as number[];
		const storedRows = await db.execute(
			sql`select (meta->'imap'->>'uid')::bigint as uid from messages
				where mailbox_id = ${mailboxId}
				  and (meta->'imap'->>'uid') is not null
				  and (meta->'imap'->>'uid')::bigint between ${start} and ${end}`,
		);
		const stored = new Set<number>(
			((storedRows as any).rows ?? (storedRows as any)).map((r: any) => Number(r.uid)),
		);
		let missing = present.filter((u) => !stored.has(u));
		const absent = missing.length;

		// Gmail's "All Mail" also contains what was already backfilled from the INBOX or Sent.
		// Read the envelopes first (a few bytes) and skip messages whose Message-ID already exists
		// for this identity: only archived mail, absent everywhere else, is downloaded.
		let known = 0;
		if (skipKnownMessages && missing.length) {
			const idByUid = new Map<number, string>();
			for await (const env of client.fetch(
				missing.join(","),
				{ uid: true, envelope: true },
				{ uid: true },
			)) {
				const mid = env.envelope?.messageId?.trim();
				if (mid) idByUid.set(env.uid, mid);
			}
			if (idByUid.size) {
				const rows = await db
					.selectDistinct({ messageId: messages.messageId })
					.from(messages)
					.innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
					.where(
						and(
							eq(mailboxes.identityId, identityId),
							inArray(messages.messageId, [...new Set(idByUid.values())]),
						),
					);
				const have = new Set(rows.map((r) => r.messageId));
				missing = missing.filter((u) => {
					const mid = idByUid.get(u);
					return !(mid && have.has(mid));
				});
				known = absent - missing.length;
			}
		}

		console.info("[imap:backfill-full] window", {
			identityId,
			path,
			range,
			present: present.length,
			stored: present.length - absent,
			known,
			missing: missing.length,
		});

		if (missing.length === 0) {
			complete = true;
		} else {
			const fetched = new Set<number>();
			for await (const msg of client.fetch(
				missing.join(","),
				{
					uid: true,
					envelope: true,
					flags: true,
					internalDate: true,
					size: true,
					source: true,
				},
				{ uid: true },
			)) {
				if (quota.limit <= 0) break;

				const m = msg as FetchMessageObject;
				const raw = m.source ? m.source.toString() : "";
				if (!raw) continue;

				const size = m.size ?? Buffer.byteLength(raw, "utf8");

				if (size > quota.limit) {
					quota.limit = 0;
					break;
				}

				batchBytes += size;
				processedCount += 1;

				const { seen, answered, flagged } = mapImapFlags(m.flags);
				const flags = Array.from(m.flags ?? []);

				// A message the database refuses must not stop the backfill: since a window is only
				// validated when complete, it would block that window forever, and the whole folder behind
				// it. Log it and move on to the next one.
				try {
					await parseAndStoreEmail(raw, {
						ownerId,
						mailboxId,
						workspaceId,
						rawStorageKey: `eml/${ownerId}/${mailboxId}/${m.id}.eml`,
						emlKey: String(m.id),
						metaData: {
							imap: {
								uid: m.uid,
								mailboxPath: path,
								flags,
								sizeBytes: m.size ?? null,
								internalDate: m.internalDate ?? null,
							},
						},
						mode: "backfill",
						seen,
						answered,
						flagged,
					});
				} catch (err: any) {
					console.error("[imap:backfill-full] message not stored, skipped", {
						identityId,
						path,
						uid: m.uid,
						error: err?.cause?.message ?? err?.message ?? String(err),
					});
				}
				fetched.add(m.uid);
			}
			complete = missing.every((u) => fetched.has(u));
		}
	} catch (err: any) {
		console.warn("[imap:backfill-full] window interrupted, cursor kept", {
			identityId,
			path,
			range,
			error: err?.message ?? String(err),
		});
		complete = false;
	}

	console.info("[imap:backfill-full] processed messages", {
		identityId,
		path,
		processedCount,
		batchBytes,
		complete,
		remainingQuota: quota.limit,
	});

	if (batchBytes > 0) {
		quota.limit = Math.max(0, quota.limit - batchBytes);
	}

	if (!complete) {
		// incomplete window: leave the cursor alone, it will be resumed later.
		if (politeWaitMs) await sleep(politeWaitMs);
		return false;
	}

	cursor = start - 1;
	const done = cursor <= 0;

	await db
		.update(mailboxSync)
		.set({
			backfillCursorUid: done ? BACKFILL_DONE : cursor,
			phase: done ? "IDLE" : "BACKFILL",
			updatedAt: new Date(),
		})
		.where(eq(mailboxSync.id, sync.id));

	if (done) {
		console.info("[imap:backfill-full] mailbox complete", { identityId, path });
		return false;
	}

	if (politeWaitMs) {
		await sleep(politeWaitMs);
	}
	return true;
}

export const startFullBackfill = async (
	imapInstances: Map<string, ImapFlow>,
) => {
	const identitiesRows = await db
		.select()
		.from(identities)
		.where(eq(identities.kind, "email"));
	const filteredRows = identitiesRows.filter((id) => {
		return !!id.smtpAccountId;
	});

	for (const identity of filteredRows) {
		// await davCreateCalendarForIdentity(identity.id)
		await davCreateCalendarForIdentity({
			identityId: identity.id,
			userId: identity.ownerId,
			workspaceId: identity.workspaceId,
		})
		const dailyQuotaBytes = getDailyQuota(identity as IdentityEntity);
		const quota = getOrInitQuota(identity.id, dailyQuotaBytes);

		if (quota.limit <= 0) {
			console.log("[imap:backfill-full] quota exhausted, skipping identity", {
				identityId: identity.id,
				remaining: quota.limit,
			});
			continue;
		}

		const client = await initSmtpClient(identity.id, imapInstances);
		if (!client) {
			console.warn(
				"[imap:backfill-full] could not init imap client for identity",
				identity.id,
			);
			continue;
		}

		await startFullBackfillForIdentity(client, identity.id, quota);
	}
};

export const startFullBackfillForIdentity = async (
	client: ImapFlow,
	identityId: string,
	quota: IdentityQuota,
) => {
	try {
		if (quota.limit <= 0) return;

		const [identity] = await db
			.select()
			.from(identities)
			.where(eq(identities.id, identityId));

		if (!identity) {
			console.warn("[imap:backfill-full] identity not found", identityId);
			return;
		}

		const ownerId = identity.ownerId;

		const mailboxRows = await db
			.select()
			.from(mailboxes)
			.where(eq(mailboxes.identityId, identityId));

		const isInbox = (row: (typeof mailboxRows)[number]) => {
			const meta = row.metaData as any;
			const imap = meta?.imap ?? {};
			const path = (imap.path as string | undefined) ?? "";
			const specialUse = (imap.specialUse as string | undefined) ?? "";

			return (
				row.isDefault === true ||
				path.toUpperCase() === "INBOX" ||
				specialUse.toUpperCase() === "\\INBOX"
			);
		};

		// On Gmail, "All Mail" (\All) holds all the mail. It goes last, deduplicated, and makes
		// backfilling the label folders pointless (the same messages, which would be downloaded
		// once per label): we want all the mail, not the folder tree.
		const isAllMail = (row: (typeof mailboxRows)[number]) =>
			String((row.metaData as any)?.imap?.specialUse ?? "").toLowerCase() ===
			"\\all";
		const hasAllMail = mailboxRows.some(isAllMail);

		const inboxFirst = [
			...mailboxRows.filter(isInbox),
			...mailboxRows.filter(
				(r) =>
					!isInbox(r) && !isAllMail(r) && !(hasAllMail && r.kind === "custom"),
			),
			...mailboxRows.filter((r) => !isInbox(r) && isAllMail(r)),
		];

		// Regular folders are backfilled in turns, one window each, then the passes repeat until a
		// folder is exhausted or the daily quota is used up. Exhausting the INBOX first would leave
		// Sent empty for hours or days on a large mailbox. Trash and spam, purged by the server
		// after a few weeks, are not worth their quota and are not backfilled (the regular sync
		// covers them). "All Mail" stays last, since it is deduplicated against the other folders.
		const eligible = inboxFirst.filter(
			(row) =>
				Boolean((row.metaData as any)?.imap?.path) &&
				row.kind !== "trash" &&
				row.kind !== "spam",
		);
		const runWindow = (row: (typeof eligible)[number]) =>
			backfillMailboxFull({
				client,
				workspaceId: identity.workspaceId,
				identityId,
				ownerId,
				mailboxId: row.id,
				path: (row.metaData as any).imap.path as string,
				quota,
				politeWaitMs: 200,
				skipKnownMessages: isAllMail(row),
			});

		let pending = eligible.filter((row) => !isAllMail(row));
		while (pending.length > 0 && quota.limit > 0) {
			const stillWorking: typeof pending = [];
			for (const row of pending) {
				if (quota.limit <= 0) break;
				if (await runWindow(row)) stillWorking.push(row);
			}
			pending = stillWorking;
		}
		for (const row of eligible.filter(isAllMail)) {
			let worked = true;
			while (worked && quota.limit > 0) {
				worked = await runWindow(row);
			}
		}
		if (quota.limit <= 0) {
			console.log("[imap:backfill-full] daily quota used up, resuming on the next pass", {
				identityId,
			});
		}
	} catch (err) {
		console.error("[imap:backfill-full] error", err);
	}
};



export async function startBackfillForIdentity(
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
) {
	const [identity] = await db
		.select()
		.from(identities)
		.where(eq(identities.id, identityId));

	if (!identity) return;

	const quota = getOrInitQuota(
		identity.id,
		getDailyQuota(identity as IdentityEntity),
	);

	if (quota.limit <= 0) return;

	const client = await initSmtpClient(identity.id, imapInstances);

	if (!client?.authenticated || !client?.usable) return;

	await davCreateCalendarForIdentity({
		identityId: identity.id,
		userId: identity.ownerId,
		workspaceId: identity.workspaceId,
	});

	await startFullBackfillForIdentity(client, identity.id, quota);
}
