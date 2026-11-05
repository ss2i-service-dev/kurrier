import { ImapFlow } from "imapflow";
import { db, mailboxes, mailboxSync, type IdentityEntity } from "@db";
import { and, eq } from "drizzle-orm";

// One Archive folder per IMAP identity. Many servers (Stalwart among others) do not create
// one by default, and without it the worker's "archive" action (mail:move, op=archive)
// finds no destination.
export async function ensureArchiveFolder(
	client: ImapFlow,
	identity: IdentityEntity,
) {
	const [local] = await db
		.select()
		.from(mailboxes)
		.where(
			and(eq(mailboxes.identityId, identity.id), eq(mailboxes.kind, "archive")),
		);
	if (local) return;

	const all: Array<any> = [];
	for await (const mbx of await client.list()) all.push(mbx);
	const remote =
		all.find((m) => (m.specialUse as string | undefined) === "\\Archive") ??
		all.find((m) => String(m.name ?? "").toLowerCase() === "archive");
	if (remote) return; // the discovery pass will register it with the right kind

	const name = "Archive";
	try {
		await client.mailboxCreate(name);
	} catch (err: any) {
		if (!/exists|already/i.test(String(err?.message))) throw err;
	}
	try {
		await client.mailboxSubscribe(name);
	} catch {}
	const box = await client.mailboxOpen(name, { readOnly: true });
	const [row] = await db
		.insert(mailboxes)
		.values({
			ownerId: identity.ownerId,
			workspaceId: identity.workspaceId,
			identityId: identity.id,
			name,
			slug: "archive",
			kind: "archive",
			isDefault: false,
			metaData: {
				imap: {
					path: name,
					name,
					parentPath: "",
					delimiter: "/",
					flags: [],
					specialUse: null,
					selectable: true,
				},
			},
		} as any)
		.returning();
	if (row) {
		await db.insert(mailboxSync).values({
			identityId: identity.id,
			mailboxId: row.id,
			uidValidity: box.uidValidity!,
			lastSeenUid: 0,
			backfillCursorUid: Math.max(0, (box.uidNext ?? 1) - 1),
			phase: "IDLE",
			syncedAt: new Date(),
		});
	}
}
