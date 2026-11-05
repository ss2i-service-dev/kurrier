// Data for the Contacts section (modern interface). Same query as the classic
// contacts layout, plus address books and labels.
import { getWorkspacePublicId, rlsClient } from "@/lib/actions/clients";
import { addressBooks, contactLabels, contacts, labels } from "@db";
import { count, eq } from "drizzle-orm";
import { getServerEnv } from "@schema";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "@/lib/create-s3-client";
import type { ContactWithFavorite } from "@/components/dashboard/contacts/contacts-list";

export async function loadKContactsData() {
	const rls = await rlsClient();
	const rows = await rls((tx) =>
		tx
			.select({ contact: contacts, labelSlug: labels.slug })
			.from(contacts)
			.leftJoin(contactLabels, eq(contactLabels.contactId, contacts.id))
			.leftJoin(labels, eq(labels.id, contactLabels.labelId)),
	);

	const grouped = new Map<string, ContactWithFavorite & { labels: string[] }>();
	for (const row of rows) {
		const existing =
			grouped.get(row.contact.id) ??
			({ ...row.contact, isFavorite: false, labels: [] } as ContactWithFavorite & { labels: string[] });
		if (row.labelSlug && !existing.labels.includes(row.labelSlug)) existing.labels.push(row.labelSlug);
		if (row.labelSlug === "favorite") existing.isFavorite = true;
		grouped.set(row.contact.id, existing);
	}
	const allContacts = Array.from(grouped.values());

	const { S3_BUCKET } = getServerEnv();
	const uniqueKeys = Array.from(new Set(allContacts.map((c) => c.profilePictureXs).filter(Boolean) as string[]));
	const profileImages = await Promise.all(
		uniqueKeys.map(async (key) => ({
			path: key,
			signedUrl: await getSignedUrl(s3, new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn: 600 }),
		})),
	);

	const [workspacePublicId, books] = await Promise.all([
		getWorkspacePublicId(),
		rls((tx) => tx.select().from(addressBooks)),
	]);

	return {
		allContacts,
		profileImages,
		workspacePublicId,
		books: books.map((b) => ({
			id: b.id,
			name: b.name,
			count: allContacts.filter((c) => c.addressBookId === b.id).length,
		})),
	};
}

// Address books and counters for the sidebar (lightweight query).
export async function loadKBooks() {
	const rls = await rlsClient();
	const [books, counts] = await Promise.all([
		rls((tx) => tx.select().from(addressBooks)),
		rls((tx) => tx.select({ id: contacts.addressBookId, n: count() }).from(contacts).groupBy(contacts.addressBookId)),
	]);
	const by = new Map(counts.map((c) => [c.id, Number(c.n)]));
	return {
		books: books.map((b) => ({ id: b.id, name: b.name, count: by.get(b.id) ?? 0 })),
		total: counts.reduce((a, c) => a + Number(c.n), 0),
	};
}
