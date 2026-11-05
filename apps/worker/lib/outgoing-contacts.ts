import { db, addressBooks, contacts } from "@db";
import { and, eq, inArray, sql } from "drizzle-orm";
import addressparser from "addressparser";
import { getRedis } from "./get-redis";

// The recipients of a sent message become contacts of the sender. Without this, the
// address book is only fed by received mail, and the person we write to never appears in it
// until they reply.
const TECHNICAL = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?)([-+.@]|$)/i;

function splitName(displayName: string | null, email: string) {
	const base = (displayName ?? "").trim() || email.split("@")[0] || "Unknown";
	const parts = base.split(/\s+/).filter(Boolean);
	return {
		firstName: parts[0] || "Unknown",
		lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
	};
}

export async function upsertContactsFromOutgoing(opts: {
	ownerIds: string[]; // users whose address book is fed
	workspaceId: string;
	ownAddresses: string[];
	recipients: Array<string | string[] | null | undefined>;
}) {
	const { workspaceId } = opts;
	const own = new Set(opts.ownAddresses.map((a) => a.toLowerCase()));

	const parsed = addressparser(
		opts.recipients
			.flatMap((r) => (Array.isArray(r) ? r : r ? [r] : []))
			.filter(Boolean)
			.join(", "),
	);

	const byEmail = new Map<string, string | null>();
	for (const p of parsed) {
		const email = String(p.address ?? "").trim().toLowerCase();
		if (!email || !email.includes("@")) continue;
		if (own.has(email) || TECHNICAL.test(email)) continue;
		if (!byEmail.has(email)) byEmail.set(email, (p.name || "").trim() || null);
	}
	if (!byEmail.size) return [];

	const ownerIds = Array.from(new Set(opts.ownerIds.filter(Boolean)));
	if (!ownerIds.length) return [];

	const books = await db
		.select({ id: addressBooks.id, ownerId: addressBooks.ownerId })
		.from(addressBooks)
		.where(
			and(eq(addressBooks.workspaceId, workspaceId), inArray(addressBooks.ownerId, ownerIds)),
		);

	const created: { ownerId: string; contactId: string }[] = [];

	for (const book of books) {
		for (const [email, name] of byEmail) {
			await db.transaction(async (tx) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtext(${book.id} || ':' || ${email}))`,
				);
				const [existing] = await tx
					.select({ id: contacts.id })
					.from(contacts)
					.where(
						and(
							eq(contacts.workspaceId, workspaceId),
							eq(contacts.addressBookId, book.id),
							sql`${contacts.emails}::jsonb @> ${JSON.stringify([{ address: email }])}::jsonb`,
						),
					)
					.limit(1);
				if (existing) return;

				const { firstName, lastName } = splitName(name, email);
				const [inserted] = await tx
					.insert(contacts)
					.values({
						ownerId: book.ownerId,
						workspaceId,
						addressBookId: book.id,
						firstName,
						lastName,
						emails: [{ address: email }],
						profilePictureXs: null,
					} as any)
					.returning({ id: contacts.id });
				if (inserted?.id) created.push({ ownerId: book.ownerId, contactId: inserted.id });
			});
		}
	}

	// Same path as contacts coming from received mail: pushed to CardDAV.
	if (created.length) {
		try {
			const { davWorkerQueue } = await getRedis();
			const byOwner = new Map<string, string[]>();
			for (const c of created) {
				byOwner.set(c.ownerId, [...(byOwner.get(c.ownerId) ?? []), c.contactId]);
			}
			for (const [ownerId, contactIds] of byOwner) {
				await davWorkerQueue.add(
					"dav:create-contacts-batch",
					{ contactIds, ownerId },
					{ removeOnComplete: true, removeOnFail: true },
				);
			}
		} catch (err: any) {
			console.error("[outgoing-contacts] dav sync enqueue failed:", err?.message ?? err);
		}
	}

	return created;
}
