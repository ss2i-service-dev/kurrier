"use server";

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { contacts, identities, recipientPairs, recipientStats } from "@db";
import { rlsClient } from "@/lib/actions/clients";
import { searchContactsForCompose } from "@/lib/actions/calendar";
import { s3 } from "@/lib/create-s3-client";
import {
	rankRecipientSuggestions,
	type RecipientCandidate,
	type RecipientPair,
} from "@common";
import { ComposeContact, getServerEnv } from "@schema";

const { S3_BUCKET } = getServerEnv();

// Recipient suggestions of the editor, ranked by actual usage (tables recipient_stats and
// recipient_pairs, migration 005, partitioned per user by RLS); the ranking is in
// packages/common/src/recipient-suggest.ts.
// `current`: addresses already entered in To, Cc and Bcc (excluded, basis of the
// association). Empty field: the best candidates without waiting for a keystroke.

const LIMIT = 10;
const CANDIDATES = 150;

// LIKE wildcards neutralised; "prefix" pattern: start of the address, of the name, of a
// word of the name or of a segment of the address (same rule as textMatch, more permissive).
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function suggestRecipients(input: {
	query: string;
	current: string[];
}): Promise<ComposeContact[]> {
	try {
		const query = String(input?.query ?? "").trim().toLowerCase().slice(0, 100);
		const current = Array.from(
			new Set(
				(Array.isArray(input?.current) ? input.current : [])
					.map((e) => String(e ?? "").trim().toLowerCase())
					.filter((e) => e.includes("@")),
			),
		).slice(0, 50);

		const rls = await rlsClient();
		const decayed = sql<number>`recipient_decay(${recipientStats.score}, ${recipientStats.lastUsedAt}, now())`;
		const prefix = `${likeEscape(query)}%`;
		const textFilter = query
			? or(
					sql`${recipientStats.email} LIKE ${prefix}`,
					sql`${recipientStats.email} LIKE ${`%@${likeEscape(query)}%`}`,
					sql`${recipientStats.email} LIKE ${`%.${likeEscape(query)}%`}`,
					sql`${recipientStats.email} LIKE ${`%-${likeEscape(query)}%`}`,
					sql`${recipientStats.email} LIKE ${`%_${likeEscape(query)}%`}`,
					sql`${recipientStats.email} LIKE ${`%+${likeEscape(query)}%`}`,
					sql`${recipientStats.name} ILIKE ${prefix}`,
					sql`${recipientStats.name} ILIKE ${`% ${likeEscape(query)}%`}`,
					sql`${recipientStats.name} ILIKE ${`%-${likeEscape(query)}%`}`,
				)
			: undefined;

		const [statsRows, pairRows, ownRows] = await rls(async (tx) => {
			const stats = await tx
				.select({
					email: recipientStats.email,
					name: recipientStats.name,
					score: decayed,
					lastUsedAt: recipientStats.lastUsedAt,
				})
				.from(recipientStats)
				.where(textFilter)
				.orderBy(sql`${decayed} DESC`)
				.limit(CANDIDATES);
			const pairs = current.length
				? await tx
						.select({
							email: recipientPairs.email,
							other: recipientPairs.other,
							score: sql<number>`recipient_decay(${recipientPairs.score}, ${recipientPairs.lastUsedAt}, now())`,
						})
						.from(recipientPairs)
						.where(inArray(recipientPairs.email, current))
						.orderBy(sql`${recipientPairs.score} DESC`)
						.limit(500)
				: [];
			const own = await tx
				.select({ value: identities.value })
				.from(identities)
				.where(eq(identities.kind, "email"));
			return [stats, pairs, own] as const;
		});

		// Candidates associated but absent from the batch (own score lower): fetch them.
		const have = new Set(statsRows.map((r) => r.email));
		const missing = Array.from(new Set(pairRows.map((p) => p.other))).filter((e) => !have.has(e));
		const extraRows = missing.length
			? await rls((tx) =>
					tx
						.select({
							email: recipientStats.email,
							name: recipientStats.name,
							score: decayed,
							lastUsedAt: recipientStats.lastUsedAt,
						})
						.from(recipientStats)
						.where(inArray(recipientStats.email, missing.slice(0, 200))),
				)
			: [];

		const candidates: RecipientCandidate[] = [...statsRows, ...extraRows].map((r) => ({
			email: r.email,
			name: r.name,
			score: Number(r.score) || 0,
			lastUsedAt: r.lastUsedAt,
		}));
		// Address book (contacts created by hand or imported): score 0, after the written addresses.
		if (query) {
			for (const c of await searchContactsForCompose(query)) {
				candidates.push({ email: c.email, name: c.name, score: 0, id: c.id, avatar: c.avatar });
			}
		}

		const ranked = rankRecipientSuggestions({
			query,
			current,
			own: ownRows.map((r) => r.value),
			candidates,
			pairs: pairRows as RecipientPair[],
			limit: LIMIT,
		});

		// Avatar and address book id for suggestions that do not have one yet.
		const lookup = ranked.filter((r) => !r.id).map((r) => r.email);
		const byEmail = new Map<string, { id: string; avatar: string | null }>();
		if (lookup.length) {
			const rows = await rls((tx) =>
				tx
					.select({
						id: contacts.id,
						emails: contacts.emails,
						profilePictureXs: contacts.profilePictureXs,
					})
					.from(contacts)
					.where(
						and(
							or(
								...lookup.map(
									(e) =>
										sql`${contacts.emails}::jsonb @> ${JSON.stringify([{ address: e }])}::jsonb`,
								),
							),
						),
					)
					.limit(lookup.length * 2),
			);
			for (const row of rows) {
				let avatar: string | null = null;
				if (row.profilePictureXs) {
					avatar = await getSignedUrl(
						s3,
						new GetObjectCommand({ Bucket: S3_BUCKET, Key: String(row.profilePictureXs) }),
						{ expiresIn: 60 },
					);
				}
				for (const e of (row.emails ?? []) as { address?: string }[]) {
					const addr = String(e?.address ?? "").trim().toLowerCase();
					if (addr && !byEmail.has(addr)) byEmail.set(addr, { id: row.id, avatar });
				}
			}
		}

		return ranked.map((r) => {
			const c = byEmail.get(r.email);
			return {
				id: r.id ?? c?.id ?? r.email,
				name: r.name ?? r.email,
				email: r.email,
				avatar: r.avatar ?? c?.avatar ?? null,
			};
		});
	} catch (err: any) {
		console.error("[recipient-suggestions] failed:", err?.message ?? err);
		return [];
	}
}
