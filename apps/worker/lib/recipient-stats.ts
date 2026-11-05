import { db } from "@db";
import { sql } from "drizzle-orm";
import addressparser from "addressparser";

// Recipient usage statistics (migration 005), basis of the editor's suggestions. A send
// (from the app, or a message synced into a Sent folder) feeds recipient_stats and
// recipient_pairs through the SQL function recipient_ingest, idempotent per (user,
// Message-ID). Never blocking.
export async function ingestRecipientStats(opts: {
	ownerIds: string[]; // users whose suggestions are fed
	messageId: string; // Message-ID RFC
	sentAt: Date | string | null | undefined;
	ownAddresses: string[]; // sender addresses, never counted
	recipients: Array<string | string[] | null | undefined>; // To, Cc, Bcc
}) {
	const own = new Set(opts.ownAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean));
	const parsed = addressparser(
		opts.recipients
			.flatMap((r) => (Array.isArray(r) ? r : r ? [r] : []))
			.filter(Boolean)
			.join(", "),
	);
	const list = parsed
		.map((p) => ({
			address: String(p.address ?? "").trim().toLowerCase(),
			name: (p.name || "").trim() || null,
		}))
		.filter((p) => p.address.includes("@") && !own.has(p.address));
	if (!list.length || !opts.messageId) return;

	const sentAt = opts.sentAt ? new Date(opts.sentAt) : new Date();
	const when = Number.isNaN(sentAt.getTime()) ? new Date() : sentAt;
	for (const ownerId of new Set(opts.ownerIds.filter(Boolean))) {
		try {
			await db.execute(
				sql`select recipient_ingest(${ownerId}::uuid, ${opts.messageId}, ${when.toISOString()}::timestamptz, ${JSON.stringify(list)}::jsonb)`,
			);
		} catch (err: any) {
			console.error("[recipient-stats] ingest failed:", err?.message ?? err);
		}
	}
}
