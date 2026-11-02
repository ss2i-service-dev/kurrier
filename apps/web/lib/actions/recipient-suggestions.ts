"use server";

import { and, eq, inArray, or, sql } from "drizzle-orm";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { contacts, identities, ss2iRecipientPairs, ss2iRecipientStats } from "@db";
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

// ss2i : suggestions de destinataires de l'editeur, classees par usage reel (tables
// ss2i_recipient_stats et ss2i_recipient_pairs, migration 005, cloisonnees par
// utilisateur par RLS) ; le classement est dans packages/common/src/recipient-suggest.ts.
// `current` : adresses deja saisies dans To, Cc et Bcc (exclues, base de l'association).
// Champ vide : les meilleurs candidats sans attendre de frappe.

const LIMIT = 10;
const CANDIDATES = 150;

// Joker LIKE neutralises ; motif « prefixe » : debut de l'adresse, du nom, d'un mot du
// nom ou d'un segment de l'adresse (meme regle que textMatch, en plus permissif).
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
		const decayed = sql<number>`ss2i_decay(${ss2iRecipientStats.score}, ${ss2iRecipientStats.lastUsedAt}, now())`;
		const prefix = `${likeEscape(query)}%`;
		const textFilter = query
			? or(
					sql`${ss2iRecipientStats.email} LIKE ${prefix}`,
					sql`${ss2iRecipientStats.email} LIKE ${`%@${likeEscape(query)}%`}`,
					sql`${ss2iRecipientStats.email} LIKE ${`%.${likeEscape(query)}%`}`,
					sql`${ss2iRecipientStats.email} LIKE ${`%-${likeEscape(query)}%`}`,
					sql`${ss2iRecipientStats.email} LIKE ${`%_${likeEscape(query)}%`}`,
					sql`${ss2iRecipientStats.email} LIKE ${`%+${likeEscape(query)}%`}`,
					sql`${ss2iRecipientStats.name} ILIKE ${prefix}`,
					sql`${ss2iRecipientStats.name} ILIKE ${`% ${likeEscape(query)}%`}`,
					sql`${ss2iRecipientStats.name} ILIKE ${`%-${likeEscape(query)}%`}`,
				)
			: undefined;

		const [statsRows, pairRows, ownRows] = await rls(async (tx) => {
			const stats = await tx
				.select({
					email: ss2iRecipientStats.email,
					name: ss2iRecipientStats.name,
					score: decayed,
					lastUsedAt: ss2iRecipientStats.lastUsedAt,
				})
				.from(ss2iRecipientStats)
				.where(textFilter)
				.orderBy(sql`${decayed} DESC`)
				.limit(CANDIDATES);
			const pairs = current.length
				? await tx
						.select({
							email: ss2iRecipientPairs.email,
							other: ss2iRecipientPairs.other,
							score: sql<number>`ss2i_decay(${ss2iRecipientPairs.score}, ${ss2iRecipientPairs.lastUsedAt}, now())`,
						})
						.from(ss2iRecipientPairs)
						.where(inArray(ss2iRecipientPairs.email, current))
						.orderBy(sql`${ss2iRecipientPairs.score} DESC`)
						.limit(500)
				: [];
			const own = await tx
				.select({ value: identities.value })
				.from(identities)
				.where(eq(identities.kind, "email"));
			return [stats, pairs, own] as const;
		});

		// Candidats associes mais absents du lot (score propre plus bas) : on les recupere.
		const have = new Set(statsRows.map((r) => r.email));
		const missing = Array.from(new Set(pairRows.map((p) => p.other))).filter((e) => !have.has(e));
		const extraRows = missing.length
			? await rls((tx) =>
					tx
						.select({
							email: ss2iRecipientStats.email,
							name: ss2iRecipientStats.name,
							score: decayed,
							lastUsedAt: ss2iRecipientStats.lastUsedAt,
						})
						.from(ss2iRecipientStats)
						.where(inArray(ss2iRecipientStats.email, missing.slice(0, 200))),
				)
			: [];

		const candidates: RecipientCandidate[] = [...statsRows, ...extraRows].map((r) => ({
			email: r.email,
			name: r.name,
			score: Number(r.score) || 0,
			lastUsedAt: r.lastUsedAt,
		}));
		// Carnet (contacts crees a la main ou importes) : score 0, apres les adresses ecrites.
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

		// Avatar et id du carnet pour les suggestions qui n'en ont pas encore.
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
