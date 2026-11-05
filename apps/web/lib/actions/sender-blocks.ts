"use server";

import { rlsClient } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";
import { getRedis } from "@/lib/actions/get-redis";
import { blockedSenders, identities, mailboxes, messages } from "@db";
import { handleAction, type FormState } from "@schema";
import {
	blockOptionsFor,
	emailDomain,
	groupBlockedMessages,
	normalizeAddress,
	normalizeDomain,
	type BlockEntry,
	type BlockKind,
} from "@common";
import { and, desc, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

// Blocked senders (table blocked_senders, per user). On reception, the worker sends the
// message to the trash (rules/blocked-senders.ts); here: creation and removal of blocks,
// and moving to the trash the mails already in the Inbox.

const TRASH_BATCH = 200;

async function ownIdentityValues(): Promise<string[]> {
	const rls = await rlsClient();
	const rows = await rls((tx) => tx.select({ value: identities.value }).from(identities));
	return rows.map((r) => r.value.trim().toLowerCase());
}

const domainsOf = (values: string[]) =>
	values.map((v) => (v.includes("@") ? emailDomain(v) : normalizeDomain(v)));

export async function fetchBlockedSenders() {
	const rls = await rlsClient();
	return rls((tx) => tx.select().from(blockedSenders).orderBy(desc(blockedSenders.createdAt)));
}

// Inbox of the user: messages from the blocked sender, per mailbox.
async function findExistingThreads(entry: BlockEntry) {
	const user = await isSignedIn();
	if (!user?.id) throw new Error("Not authenticated");
	const rls = await rlsClient();
	const likeEsc = (s: string) => s.replace(/[\\%_]/g, "\\$&");
	const addr = sql`lower(${messages.from} -> 'value' -> 0 ->> 'address')`;
	const cond =
		entry.kind === "address"
			? sql`${addr} = ${entry.value}`
			: sql`(${addr} LIKE ${"%@" + likeEsc(entry.value)} OR ${addr} LIKE ${"%." + likeEsc(entry.value)})`;
	const rows = await rls((tx) =>
		tx
			.select({
				id: messages.id,
				mailboxId: messages.mailboxId,
				threadId: messages.threadId,
				address: sql<string>`${addr}`,
			})
			.from(messages)
			.innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
			.where(and(eq(mailboxes.kind, "inbox"), eq(mailboxes.ownerId, user.id), eq(messages.draft, false), cond)),
	);
	// Re-check in JS with the same function as the worker, then group by mailbox.
	const byMailbox = groupBlockedMessages(rows, [entry]);
	let count = 0;
	for (const list of byMailbox.values()) count += list.length;
	return { messages: count, byMailbox };
}

// Number of Inbox mails concerned, for the confirmation.
export async function countExistingFromSender(kind: BlockKind, value: string): Promise<number> {
	const v = kind === "domain" ? normalizeDomain(value) : normalizeAddress(value);
	if (!v) return 0;
	return (await findExistingThreads({ kind, value: v })).messages;
}

export async function blockSender(input: {
	kind: BlockKind;
	value: string;
	trashExisting: boolean;
	pathname?: string;
}): Promise<FormState<{ blocked: string; moved: number }>> {
	return handleAction(async () => {
		const user = await isSignedIn();
		if (!user?.id) return { success: false, error: "Not authenticated" };
		const kind: BlockKind = input.kind === "domain" ? "domain" : "address";
		const value = kind === "domain" ? normalizeDomain(input.value) : normalizeAddress(input.value);
		if (!value || (kind === "address" && !value.includes("@")) || (kind === "domain" && !value.includes("."))) {
			return { success: false, error: "Invalid sender" };
		}
		const own = await ownIdentityValues();
		if (kind === "domain") {
			// Public mail domains and the user's own domains: refused server-side too.
			const opts = blockOptionsFor(`x@${value}`, domainsOf(own));
			if (!opts.domain) {
				return { success: false, error: `Cannot block the domain ${value}: block the address instead` };
			}
		} else if (own.includes(value)) {
			return { success: false, error: "Cannot block one of your own addresses" };
		}

		const rls = await rlsClient();
		await rls((tx) =>
			tx
				.insert(blockedSenders)
				.values({ ownerId: user.id, kind, value } as any)
				.onConflictDoNothing(),
		);

		let moved = 0;
		if (input.trashExisting) {
			const found = await findExistingThreads({ kind, value });
			moved = found.messages;
			const { smtpQueue, searchIngestQueue } = await getRedis();
			for (const [mailboxId, list] of found.byMailbox) {
				for (let i = 0; i < list.length; i += TRASH_BATCH) {
					const batch = list.slice(i, i + TRASH_BATCH);
					const threadIds = Array.from(new Set(batch.map((m) => m.threadId)));
					// One job per batch, at message granularity: only the sender's messages
					// are moved (a thread with nothing else left in the Inbox moves entirely, see
					// moveMail). The worker updates the database then does one IMAP MOVE per mailbox.
					await smtpQueue.add(
						"mail:move",
						{
							threadId: threadIds[0],
							threadIds,
							messageIds: batch.map((m) => m.id),
							mailboxId,
							op: "trash",
							moveImap: true,
						},
						{
							attempts: 3,
							backoff: { type: "exponential", delay: 1500 },
							removeOnComplete: true,
							removeOnFail: false,
						},
					);
					await Promise.all(
						threadIds.map((threadId) =>
							searchIngestQueue.add(
								"refresh-thread",
								{ threadId },
								{
									jobId: `refresh-${threadId}`,
									removeOnComplete: true,
									removeOnFail: false,
									attempts: 3,
									backoff: { type: "exponential", delay: 1500 },
								},
							),
						),
					);
				}
			}
		}
		revalidatePath("/mail");
		return { success: true, data: { blocked: value, moved } };
	});
}

export async function unblockSender(id: string): Promise<FormState> {
	return handleAction(async () => {
		const rls = await rlsClient();
		await rls((tx) => tx.delete(blockedSenders).where(eq(blockedSenders.id, id)));
		revalidatePath("/mail");
		return { success: true };
	});
}

// What the "Block" menu offers for a sender: the domain only if it is neither a public
// mail domain nor the user's own.
// Server helper, not exported (any export of a "use server" file is a callable action).
async function previewBlockOptions(email: string) {
	return blockOptionsFor(email, domainsOf(await ownIdentityValues()));
}
