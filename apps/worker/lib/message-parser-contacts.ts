import {db, addressBooks, contacts, identities, mailboxes, workspaceMembers, workspaceIdentityMembers} from "@db";
import { upsertContactsFromOutgoing } from "./outgoing-contacts";
import { ingestRecipientStats } from "./recipient-stats";
import { autoMailKind } from "@common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {ParsedMail} from "mailparser";

function getFromAddress(parsed: ParsedMail) {
    const from = parsed.from?.value?.[0];
    if (!from?.address) return null;
    return {
        email: from.address.trim().toLowerCase(),
        name: (from.name || "").trim() || null,
    };
}

async function getMailboxContext(mailboxId: string) {
    const [mb] = await db
        .select({
            workspaceId: mailboxes.workspaceId,
            identityId: mailboxes.identityId,
            kind: mailboxes.kind,
            identityValue: identities.value,
        })
        .from(mailboxes)
        .leftJoin(identities, eq(identities.id, mailboxes.identityId))
        .where(eq(mailboxes.id, mailboxId))
        .limit(1);

    if (!mb?.workspaceId) return null;
    return mb;
}

function splitName(displayName: string | null) {
    if (!displayName) return { firstName: "Unknown", lastName: null as string | null };
    const parts = displayName.split(" ").filter(Boolean);
    return {
        firstName: parts[0] || "Unknown",
        lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
    };
}

export async function upsertWorkspaceSharedContactFromMessage(opts: {
    parsed: ParsedMail;
    mailboxId: string;
    fallbackOwnerId: string;
}) {
    const { parsed, mailboxId, fallbackOwnerId } = opts;

    const mb = await getMailboxContext(mailboxId);
    if (!mb) return null;

    // The address book only receives people we wrote to. A message in the Sent folder
    // (including one written outside kurrier, from Gmail for example) adds its recipients
    // to it; received mail no longer adds anyone.
    if (mb.kind === "sent") {
        // Automatic mail from kurrier (unsubscribe): neither address book nor suggestions.
        if (autoMailKind(parsed.headers as Map<string, any>)) return null;
        try {
            await upsertContactsFromOutgoing({
                ownerIds: [fallbackOwnerId],
                workspaceId: mb.workspaceId,
                ownAddresses: [String(mb.identityValue ?? "")].filter(Boolean),
                recipients: [
                    (parsed.to as any)?.text ?? null,
                    (parsed.cc as any)?.text ?? null,
                ],
            });
        } catch (err: any) {
            console.error("[contacts] sent recipients failed:", err?.message ?? err);
        }
        // and feed the recipient suggestions (including sends made outside kurrier).
        if (parsed.messageId) {
            await ingestRecipientStats({
                ownerIds: [fallbackOwnerId],
                messageId: parsed.messageId,
                sentAt: parsed.date ?? null,
                ownAddresses: [String(mb.identityValue ?? "")].filter(Boolean),
                recipients: [
                    (parsed.to as any)?.text ?? null,
                    (parsed.cc as any)?.text ?? null,
                    (parsed.bcc as any)?.text ?? null,
                ],
            });
        }
        return null;
    }

    const addr = getFromAddress(parsed);
    if (!addr) return null;

    if (!mb.identityId) return null;

    const email = addr.email.trim().toLowerCase();
    const displayName = addr.name;

    const members = await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, mb.workspaceId));

    const userIds = members.map((m) => m.userId);
    if (!userIds.length) return null;

    const books = await db
        .select({ id: addressBooks.id, ownerId: addressBooks.ownerId, workspaceId: addressBooks.workspaceId })
        .from(addressBooks)
        .where(
            and(
                eq(addressBooks.workspaceId, mb.workspaceId),
                inArray(addressBooks.ownerId, userIds),
            ),
        );

    const bookByOwner = new Map(books.map((b) => [b.ownerId, b]));

    const results: { ownerId: string; contactId: string }[] = [];
    let targetUserIds = userIds;

    if (mb.identityId) {
        const members = await db
            .select({ userId: workspaceIdentityMembers.userId })
            .from(workspaceIdentityMembers)
            .where(eq(workspaceIdentityMembers.identityId, mb.identityId));

        targetUserIds = members.map((m) => m.userId);

        if (!targetUserIds.length) targetUserIds = [fallbackOwnerId];
    }

    await db.transaction(async (tx) => {
        for (const ownerId of targetUserIds) {
            const book = bookByOwner.get(ownerId);
            if (!book) continue;

            await tx.execute(
                sql`select pg_advisory_xact_lock(hashtext(${book.id} || ':' || ${email}))`,
            );

            const [existing] = await tx
                .select()
                .from(contacts)
                .where(
                    and(
                        eq(contacts.workspaceId, book.workspaceId),
                        eq(contacts.addressBookId, book.id),
                        sql`${contacts.emails}::jsonb @> ${JSON.stringify([{ address: email }])}::jsonb`,
                    ),
                )
                .limit(1);

            // An unknown sender no longer becomes a contact.
            if (!existing) continue;

            const hasName = !!(existing.firstName || existing.lastName);
            if (!hasName && displayName) {
                const { firstName, lastName } = splitName(displayName);
                await tx.update(contacts).set({ firstName, lastName }).where(eq(contacts.id, existing.id));
            }

            results.push({ ownerId, contactId: existing.id });
        }
    });

    const forFallback = results.find((r) => r.ownerId === fallbackOwnerId) ?? results[0] ?? null;
    return { insertedOrFound: results, contactIdForMessage: forFallback?.contactId ?? null };
}
