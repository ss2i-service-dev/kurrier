import { ImapFlow, FetchMessageObject } from "imapflow";
import { db, identities, IdentityEntity, mailboxes, mailboxSync } from "@db";
import { and, eq, sql } from "drizzle-orm";
import { parseAndStoreEmail } from "../../message-payload-parser";
import { initSmtpClient } from "../../../lib/imap/imap-client";
import { defaultImapQuota } from "@schema";
import dayjs from "dayjs";
import {
	davCreateCalendarForIdentity
} from "../../../lib/dav/calendar/dav-create-addressbook-calendar-for-identity";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export type IdentityQuota = {
	limit: number;
	expiresAt: string;
};

const identityQuotaMap = new Map<string, IdentityQuota>();
export function getOrInitQuota(
	identityId: string,
	dailyLimitBytes: number,
): IdentityQuota {
	const now = dayjs();
	const existing = identityQuotaMap.get(identityId);

	if (existing && now.isBefore(existing.expiresAt)) {
		return existing;
	}

	const quota: IdentityQuota = {
		limit: dailyLimitBytes,
		expiresAt: now.add(1, "day").toISOString()
	};

	identityQuotaMap.set(identityId, quota);
	return quota;
}

function getDailyQuota(identity: IdentityEntity): number {
	const meta = (identity.metaData as any) ?? {};
	const val = Number(meta.dailyQuota);
	return Number.isFinite(val) && val > 0 ? val : defaultImapQuota;
}

function mapImapFlags(flags?: string[] | Set<string>) {
	const f = Array.isArray(flags) ? flags : Array.from(flags ?? []);
	const has = (x: string) => f.some((v) => v.toLowerCase() === x.toLowerCase());

	return {
		seen: has("\\seen"),
		answered: has("\\answered"),
		flagged: has("\\flagged"),
		draft: has("\\draft"),
	};
}

type BackfillMailboxOpts = {
	client: ImapFlow;
	identityId: string;
	ownerId: string;
	workspaceId: string;
	mailboxId: string;
	path: string;
	window?: number;
	politeWaitMs?: number;
	quota: IdentityQuota;
};

const DEFAULT_WINDOW = 300;

// ss2i : valeur de `backfill_cursor_uid` qui veut dire « rattrapage de ce dossier termine ».
// L'amont n'avait que 0, qui veut aussi dire « jamais commence » : arrive en bas, le dossier
// repartait du haut au passage suivant. Avec les fenetres enchainees, le rattrapage tournait
// alors en boucle sur l'INBOX (terminee) sans jamais passer aux dossiers suivants ni finir.
// Pour rejouer un dossier : remettre son curseur a 0 (ou a un UID).
const BACKFILL_DONE = -1;

async function backfillMailboxFull(opts: BackfillMailboxOpts): Promise<boolean> {
	const {
		client,
		identityId,
		ownerId,
		mailboxId,
		path,
		window = DEFAULT_WINDOW,
		politeWaitMs = 0,
		quota,
		workspaceId
	} = opts;

	if (quota.limit <= 0) return false;

	const box = await client.mailboxOpen(path, { readOnly: true });
	const top = Math.max(0, (box.uidNext ?? 1) - 1);

	const [sync] = await db
		.select()
		.from(mailboxSync)
		.where(
			and(
				eq(mailboxSync.identityId, identityId),
				eq(mailboxSync.mailboxId, mailboxId),
			),
		);

	if (!sync) {
		console.warn("[imap:backfill-full] mailbox_sync missing", {
			identityId,
			mailboxId,
			path,
		});
		return false;
	}

	if (!sync.lastSeenUid || Number(sync.lastSeenUid) === 0) {
		const TAIL_WINDOW = 200;
		const bootLastSeen = Math.max(0, top - TAIL_WINDOW + 1);

		await db
			.update(mailboxSync)
			.set({
				lastSeenUid: bootLastSeen,
				updatedAt: new Date(),
			})
			.where(eq(mailboxSync.id, sync.id));

		// update local copy so any later logic sees it
		sync.lastSeenUid = bootLastSeen as any;
	}

	let cursor = Number(sync.backfillCursorUid ?? 0);

	if (cursor === BACKFILL_DONE) return false;

	// Nothing left to backfill for this mailbox
	if (cursor <= 0) {
		if (top <= 0) {
			await db
				.update(mailboxSync)
				.set({
					phase: "IDLE",
					backfillCursorUid: 0,
					updatedAt: new Date(),
				})
				.where(eq(mailboxSync.id, sync.id));
			return false;
		}

		cursor = top;

		await db
			.update(mailboxSync)
			.set({
				backfillCursorUid: cursor,
				phase: "BACKFILL",
				updatedAt: new Date(),
			})
			.where(eq(mailboxSync.id, sync.id));
	}

	await db
		.update(mailboxSync)
		.set({ phase: "BACKFILL", updatedAt: new Date() })
		.where(eq(mailboxSync.id, sync.id));

	const end = cursor;
	const start = Math.max(1, end - window + 1);
	const range = `${start}:${end}`;
	console.info("[imap:backfill-full] batch range", { identityId, path, range });

	// ss2i : la fenetre est traitee de facon idempotente. L'amont parcourait `client.fetch(range)`
	// et avancait le curseur quoi qu'il arrive ; or imapflow termine silencieusement l'iteration
	// quand la connexion tombe (Gmail coupe au bout du socketTimeout quand il nous ralentit), et
	// l'amont sortait aussi de la boucle a l'epuisement du quota : dans les deux cas les UID restants
	// de la fenetre etaient sautes pour toujours (32 fenetres sur 32 tronquees le 03/10/2026).
	// Desormais : 1) on demande au serveur les UID presents dans la fenetre ; 2) on retire ceux deja
	// en base ; 3) on ne recupere que les manquants ; 4) le curseur n'avance que si la fenetre est
	// complete. Une fenetre incomplete sera reprise au passage suivant, en ne refaisant que les trous.
	// Corollaire : remettre `backfill_cursor_uid` en haut rejoue tout le rattrapage a moindre cout.
	let batchBytes = 0;
	let processedCount = 0;
	let complete = false;

	try {
		const searchRes = await client.search({ uid: range }, { uid: true });
		if (searchRes === false) throw new Error("UID SEARCH a echoue, fenetre conservee");
		const present = (searchRes || []) as number[];
		const storedRows = await db.execute(
			sql`select (meta->'imap'->>'uid')::bigint as uid from messages
				where mailbox_id = ${mailboxId}
				  and (meta->'imap'->>'uid') is not null
				  and (meta->'imap'->>'uid')::bigint between ${start} and ${end}`,
		);
		const stored = new Set<number>(
			((storedRows as any).rows ?? (storedRows as any)).map((r: any) => Number(r.uid)),
		);
		const missing = present.filter((u) => !stored.has(u));
		console.info("[imap:backfill-full] window", {
			identityId,
			path,
			range,
			present: present.length,
			stored: present.length - missing.length,
			missing: missing.length,
		});

		if (missing.length === 0) {
			complete = true;
		} else {
			const fetched = new Set<number>();
			for await (const msg of client.fetch(
				missing.join(","),
				{
					uid: true,
					envelope: true,
					flags: true,
					internalDate: true,
					size: true,
					source: true,
				},
				{ uid: true },
			)) {
				if (quota.limit <= 0) break;

				const m = msg as FetchMessageObject;
				const raw = m.source ? m.source.toString() : "";
				if (!raw) continue;

				const size = m.size ?? Buffer.byteLength(raw, "utf8");

				if (size > quota.limit) {
					quota.limit = 0;
					break;
				}

				batchBytes += size;
				processedCount += 1;

				const { seen, answered, flagged } = mapImapFlags(m.flags);
				const flags = Array.from(m.flags ?? []);

				await parseAndStoreEmail(raw, {
					ownerId,
					mailboxId,
					workspaceId,
					rawStorageKey: `eml/${ownerId}/${mailboxId}/${m.id}.eml`,
					emlKey: String(m.id),
					metaData: {
						imap: {
							uid: m.uid,
							mailboxPath: path,
							flags,
							sizeBytes: m.size ?? null,
							internalDate: m.internalDate ?? null,
						},
					},
					mode: "backfill",
					seen,
					answered,
					flagged,
				});
				fetched.add(m.uid);
			}
			complete = missing.every((u) => fetched.has(u));
		}
	} catch (err: any) {
		console.warn("[imap:backfill-full] window interrupted, cursor kept", {
			identityId,
			path,
			range,
			error: err?.message ?? String(err),
		});
		complete = false;
	}

	console.info("[imap:backfill-full] processed messages", {
		identityId,
		path,
		processedCount,
		batchBytes,
		complete,
		remainingQuota: quota.limit,
	});

	if (batchBytes > 0) {
		quota.limit = Math.max(0, quota.limit - batchBytes);
	}

	if (!complete) {
		// fenetre incomplete : on ne touche pas au curseur, elle sera reprise plus tard.
		if (politeWaitMs) await sleep(politeWaitMs);
		return false;
	}

	cursor = start - 1;
	const done = cursor <= 0;

	await db
		.update(mailboxSync)
		.set({
			backfillCursorUid: done ? BACKFILL_DONE : cursor,
			phase: done ? "IDLE" : "BACKFILL",
			updatedAt: new Date(),
		})
		.where(eq(mailboxSync.id, sync.id));

	if (done) {
		console.info("[imap:backfill-full] mailbox complete", { identityId, path });
		return false;
	}

	if (politeWaitMs) {
		await sleep(politeWaitMs);
	}
	return true;
}

export const startFullBackfill = async (
	imapInstances: Map<string, ImapFlow>,
) => {
	const identitiesRows = await db
		.select()
		.from(identities)
		.where(eq(identities.kind, "email"));
	const filteredRows = identitiesRows.filter((id) => {
		return !!id.smtpAccountId;
	});

	for (const identity of filteredRows) {
		// await davCreateCalendarForIdentity(identity.id)
		await davCreateCalendarForIdentity({
			identityId: identity.id,
			userId: identity.ownerId,
			workspaceId: identity.workspaceId,
		})
		const dailyQuotaBytes = getDailyQuota(identity as IdentityEntity);
		const quota = getOrInitQuota(identity.id, dailyQuotaBytes);

		if (quota.limit <= 0) {
			console.log("[imap:backfill-full] quota exhausted, skipping identity", {
				identityId: identity.id,
				remaining: quota.limit,
			});
			continue;
		}

		const client = await initSmtpClient(identity.id, imapInstances);
		if (!client) {
			console.warn(
				"[imap:backfill-full] could not init imap client for identity",
				identity.id,
			);
			continue;
		}

		await startFullBackfillForIdentity(client, identity.id, quota);
	}
};

export const startFullBackfillForIdentity = async (
	client: ImapFlow,
	identityId: string,
	quota: IdentityQuota,
) => {
	try {
		if (quota.limit <= 0) return;

		const [identity] = await db
			.select()
			.from(identities)
			.where(eq(identities.id, identityId));

		if (!identity) {
			console.warn("[imap:backfill-full] identity not found", identityId);
			return;
		}

		const ownerId = identity.ownerId;

		const mailboxRows = await db
			.select()
			.from(mailboxes)
			.where(eq(mailboxes.identityId, identityId));

		const isInbox = (row: (typeof mailboxRows)[number]) => {
			const meta = row.metaData as any;
			const imap = meta?.imap ?? {};
			const path = (imap.path as string | undefined) ?? "";
			const specialUse = (imap.specialUse as string | undefined) ?? "";

			return (
				row.isDefault === true ||
				path.toUpperCase() === "INBOX" ||
				specialUse.toUpperCase() === "\\INBOX"
			);
		};

		const inboxFirst = [
			...mailboxRows.filter(isInbox),
			...mailboxRows.filter((r) => !isInbox(r)),
		];

		// ss2i : l'amont ne traitait qu'une fenetre de 300 UID par dossier et par passage, puis
		// attendait le planificateur du lendemain. Sur une grosse boite (150 000 messages dans
		// l'INBOX) cela representait plus d'un an de rattrapage. On enchaine desormais les
		// fenetres, dossier par dossier (INBOX d'abord), jusqu'a ce qu'un dossier soit epuise ou
		// que le quota quotidien soit consomme. La corbeille et le spam, purges par le serveur au
		// bout de quelques semaines, ne valent pas leur poids dans le quota : on ne les rattrape pas
		// (la synchronisation courante les couvre).
		for (const row of inboxFirst) {
			if (quota.limit <= 0) break;

			const path = (row.metaData as any)?.imap?.path as string | undefined;
			if (!path) continue;
			if (row.kind === "trash" || row.kind === "spam") continue;

			let worked = true;
			while (worked && quota.limit > 0) {
				worked = await backfillMailboxFull({
					client,
					workspaceId: identity.workspaceId,
					identityId,
					ownerId,
					mailboxId: row.id,
					path,
					quota,
					politeWaitMs: 200,
				});
			}
		}
		if (quota.limit <= 0) {
			console.log("[imap:backfill-full] quota du jour consomme, reprise au prochain passage", {
				identityId,
			});
		}
	} catch (err) {
		console.error("[imap:backfill-full] error", err);
	}
};



export async function startBackfillForIdentity(
	identityId: string,
	imapInstances: Map<string, ImapFlow>,
) {
	const [identity] = await db
		.select()
		.from(identities)
		.where(eq(identities.id, identityId));

	if (!identity) return;

	const quota = getOrInitQuota(
		identity.id,
		getDailyQuota(identity as IdentityEntity),
	);

	if (quota.limit <= 0) return;

	const client = await initSmtpClient(identity.id, imapInstances);

	if (!client?.authenticated || !client?.usable) return;

	await davCreateCalendarForIdentity({
		identityId: identity.id,
		userId: identity.ownerId,
		workspaceId: identity.workspaceId,
	});

	await startFullBackfillForIdentity(client, identity.id, quota);
}
