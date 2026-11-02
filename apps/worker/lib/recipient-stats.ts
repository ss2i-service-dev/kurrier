import { db } from "@db";
import { sql } from "drizzle-orm";
import addressparser from "addressparser";

// ss2i : statistiques d'usage des destinataires (migration 005), base des suggestions
// de l'editeur. Un envoi (depuis courrier, ou message synchronise dans un dossier
// Envoyes) alimente ss2i_recipient_stats et ss2i_recipient_pairs par la fonction SQL
// ss2i_recipient_ingest, idempotente par (utilisateur, Message-ID). Jamais bloquant.
export async function ingestRecipientStats(opts: {
	ownerIds: string[]; // utilisateurs dont les suggestions sont alimentees
	messageId: string; // Message-ID RFC
	sentAt: Date | string | null | undefined;
	ownAddresses: string[]; // adresses de l'expediteur, jamais comptees
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
				sql`select ss2i_recipient_ingest(${ownerId}::uuid, ${opts.messageId}, ${when.toISOString()}::timestamptz, ${JSON.stringify(list)}::jsonb)`,
			);
		} catch (err: any) {
			console.error("[recipient-stats] ingest failed:", err?.message ?? err);
		}
	}
}
