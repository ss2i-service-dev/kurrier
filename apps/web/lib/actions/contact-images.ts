"use server";

import { and, eq, sql } from "drizzle-orm";
import { addressBooks, contacts } from "@db";
import { rlsClient } from "@/lib/actions/clients";
import { isSignedIn } from "@/lib/actions/auth";

// Preference « toujours charger les images distantes » portee par le CONTACT
// (contacts.meta.loadRemoteImages), donc valable sur tous les navigateurs de
// l'utilisateur, a la difference d'une memorisation locale.

async function findContactByEmail(email: string) {
	const rls = await rlsClient();
	const [row] = await rls((tx) =>
		tx
			.select({ id: contacts.id, metaData: contacts.metaData })
			.from(contacts)
			.innerJoin(addressBooks, eq(contacts.addressBookId, addressBooks.id))
			.where(
				sql`${contacts.emails}::jsonb @> ${JSON.stringify([{ address: email }])}::jsonb`,
			)
			.limit(1),
	);
	return row ?? null;
}

export async function remoteImagesAllowedForContact(email: string | null | undefined) {
	const addr = String(email ?? "").trim().toLowerCase();
	if (!addr.includes("@")) return false;
	try {
		const row = await findContactByEmail(addr);
		return Boolean((row?.metaData as any)?.loadRemoteImages);
	} catch {
		return false;
	}
}

export async function setRemoteImagesForContact(input: {
	email: string;
	name?: string | null;
	allow: boolean;
}) {
	const addr = String(input.email ?? "").trim().toLowerCase();
	if (!addr.includes("@")) return { success: false, error: "Invalid address" };
	const user = await isSignedIn();
	if (!user) return { success: false, error: "Not authenticated" };

	const rls = await rlsClient();
	const existing = await findContactByEmail(addr);

	if (existing) {
		const meta = { ...((existing.metaData as Record<string, unknown>) ?? {}) };
		if (input.allow) meta.loadRemoteImages = true;
		else delete meta.loadRemoteImages;
		await rls((tx) =>
			tx.update(contacts).set({ metaData: meta }).where(eq(contacts.id, existing.id)),
		);
		return { success: true, created: false };
	}

	if (!input.allow) return { success: true, created: false };

	// Pas encore de contact : on le cree dans le carnet de l'utilisateur.
	const [book] = await rls((tx) =>
		tx
			.select({ id: addressBooks.id })
			.from(addressBooks)
			.where(eq(addressBooks.ownerId, user.id))
			.limit(1),
	);
	if (!book) return { success: false, error: "No address book" };

	const base = String(input.name ?? "").trim() || addr.split("@")[0];
	const parts = base.split(/\s+/).filter(Boolean);
	await rls((tx) =>
		tx.insert(contacts).values({
			ownerId: user.id,
			addressBookId: book.id,
			firstName: parts[0] || "Unknown",
			lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
			emails: [{ address: addr }],
			metaData: { loadRemoteImages: true },
		} as any),
	);
	return { success: true, created: true };
}
