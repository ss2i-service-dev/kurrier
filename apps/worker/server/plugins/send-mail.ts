import { defineNitroPlugin } from "nitropack/runtime";
import {
	AddressObjectJSON,
	ComposeMode,
	getServerEnv,
	MailComposeInput,
} from "@schema";
import { getMessageAddress, getMessageName } from "@common/mail-client";
import { AUTO_MAIL_HEADER } from "@common";
import {
	composeMessage,
	formatQuoteDate,
	generateSnippet,
	quoteOverrideOf,
	quoteScopeOf,
	messageIdFor,
	rehydrateActionOf,
	SCHEDULED_JOB,
	scheduledJobOf,
	scheduledPendingSend,
	setDraftSendState,
	draftSendErrorOf,
	upsertMailboxThreadItem,
	type QuoteOverride,
	type QuoteScope,
} from "@common";
const serverConfig = getServerEnv();
import IORedis from "ioredis";
import { Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import {
	db,
	decryptAdminSecrets,
	draftMessages,
	identities,
	mailboxes,
	MessageAttachmentInsertSchema,
	messageAttachments,
	MessageCreate,
	MessageInsertSchema,
	messages,
	providers,
	providerSecrets,
	smtpAccounts,
	smtpAccountSecrets,
	threads,
	workspaces,
} from "@db";
import { createMailer } from "@providers";
import {
	finalizeSent,
	legacyLedgerRow,
	runSend,
	sweepLedger,
	type FinalizeIo,
	type LedgerRow,
	type Prepared,
	type SendDeps,
	type SendOutcome,
} from "../../lib/send/pipeline";
import { findByLegacyKey, ledgerStore, lockLedgerRow } from "../../lib/send/ledger-store";
import { toArray } from "drizzle-orm/mysql-core";
import { and, eq, isNull, sql } from "drizzle-orm";
import addressparser from "addressparser";
import { PgTransaction } from "drizzle-orm/pg-core";
import { getRedis } from "../../lib/get-redis";
import { enqueueCrmLinkByIdentity } from "../../lib/crm/enqueue";
import {GetObjectCommand, PutObjectCommand} from "@aws-sdk/client-s3";
import {s3} from "../../lib/create-s3-client";
import { upsertContactsFromOutgoing } from "../../lib/outgoing-contacts";
import { ingestRecipientStats } from "../../lib/recipient-stats";
import { deleteDraft } from "../../lib/drafts/draft-service";
import { allowedAttachmentKeys, originalUsableBy } from "../../lib/send-guards";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
// import MailComposer from "nodemailer/lib/mail-composer";
const connection = new IORedis({
	maxRetriesPerRequest: null,
	password: serverConfig.REDIS_PASSWORD,
	host: serverConfig.REDIS_HOST || "redis",
	port: Number(serverConfig.REDIS_PORT || 6379),
});

type AttachmentDownload = {
	item: ReturnType<typeof MessageAttachmentInsertSchema.parse>;
	blob: Blob;
	name: string;
	sizeBytes: number;
	contentType?: string;
};

export default defineNitroPlugin(async (nitroApp) => {
	// ss2i : Boite d'envoi (OI 10519). Un seul chemin d'envoi, arbitre par la ligne ledger
	// draft_messages (lib/send/pipeline.ts) : envoi programme ou differe (SCHEDULED_JOB, jobId =
	// ligne) et job herite « send-and-reconcile », qui recoit sa ligne avant de partir. Un echec
	// leve pour que l'attente du job (desinscription, MCP) le voie ; jamais de renvoi automatique.
	const settle = (res: SendOutcome) => {
		if (res.outcome === "failed" || res.outcome === "interrupted") throw new Error(res.error);
		if (res.outcome === "skipped" && res.row?.status === "failed") {
			throw new Error(String(res.row.payload?.__error ?? "Sending failed"));
		}
		return { success: true, outcome: res.outcome };
	};
	const worker = new Worker(
		"send-mail",
		async (job) => {
			let rowId = "";
			try {
				switch (job.name) {
					case SCHEDULED_JOB:
						rowId = String(job.data?.draftMessageId ?? "");
						return settle(await runSend(rowId, sendDeps));
					case "send-and-reconcile":
						rowId = await legacyRowOf(job);
						return settle(await runSend(rowId, sendDeps));
					default:
						return { success: true };
				}
			} finally {
				attachmentCache.delete(rowId);
			}
		},
		{ connection },
	);

	worker.on("completed", (job) => {
		console.log(`[send-mail] ${job.id} completed`);
	});
	// Les marques du brouillon (pendingSend, sendError) sont posees par le pipeline, a partir de
	// la ligne : ici, seulement le journal (un retrait ici deverrouillerait un brouillon dont la
	// ligne est encore « sending »).
	worker.on("failed", (job, err) => {
		console.error(`[send-mail] ${job?.id} failed: ${err?.message}`);
	});

	// ss2i : les envois programmes survivent a un redemarrage du worker ou a une perte de Redis :
	// chaque ligne « scheduled » retrouve son job (jobId = ligne, rejouer l'ajout est sans effet),
	// avec l'identite d'envoi dans les donnees (controle d'acces de « Annuler »). Les lignes restees
	// en « sending » sont traitees par le balayage du ledger (sweepLedger, en fin de fichier).
	const rehydrateScheduled = async () => {
		const { sendMailQueue } = await getRedis();
		const rows = await db
			.select()
			.from(draftMessages)
			.where(eq(draftMessages.status, "scheduled"));
		let added = 0;
		// La marque d'envoi du brouillon ne se pose que si la ligne est encore « scheduled » (une
		// annulation entre la lecture et ici ne doit pas laisser de marque).
		const stillScheduled = async (rowId: string) => {
			const [r] = await db
				.select({ status: draftMessages.status })
				.from(draftMessages)
				.where(eq(draftMessages.id, rowId))
				.limit(1);
			return r?.status === "scheduled";
		};
		for (const row of rows) {
			try {
				const job = scheduledJobOf(row);
				const existing = await sendMailQueue.getJob(row.id);
				const action = rehydrateActionOf(existing ? await existing.getState() : null);
				if (action === "skip") {
					// Job termine alors que la ligne est restee « scheduled » : jamais rejoue (double envoi).
					console.warn(`[send-mail] scheduled ${row.id}: job completed but row still scheduled, left as is`);
					continue;
				}
				if (action === "fail") {
					// Job en echec sans que la ligne ait suivi : la ligne passe en « failed » (plus de
					// reprise ni de marque), l'erreur reste sur le brouillon (badge « Not sent »).
					const message = existing?.failedReason || "Scheduled send failed";
					const failed = await db
						.update(draftMessages)
						.set({
							status: "failed",
							lastError: message,
							payload: { ...row.payload, __error: message },
							updatedAt: new Date(),
						})
						.where(and(eq(draftMessages.id, row.id), eq(draftMessages.status, "scheduled")))
						.returning({ id: draftMessages.id });
					if (failed.length && job.data.imapDraftId) {
						await setDraftSendState(job.data.imapDraftId, {
							pendingSend: null,
							sendError: { message, at: new Date().toISOString() },
						});
					}
					continue;
				}
				if (action === "keep") {
					if (!(existing!.data as any)?.identityId) await existing!.updateData(job.data);
				} else {
					await sendMailQueue.add(job.name, job.data, job.opts);
					added++;
				}
				// Marque d'envoi du brouillon (absente des envois programmes avant ce patch), posee
				// apres l'ajout effectif du job.
				if (job.data.imapDraftId) {
					if (await stillScheduled(row.id)) {
						await setDraftSendState(job.data.imapDraftId, {
							pendingSend: scheduledPendingSend(row),
						});
					} else if (action === "add") {
						await (await sendMailQueue.getJob(row.id))?.remove().catch(() => {});
					}
				}
			} catch (e: any) {
				console.error(`[send-mail] scheduled ${row.id} not restored:`, e?.message ?? e);
			}
		}
		console.log(`[send-mail] scheduled sends: ${rows.length} pending, ${added} job(s) restored`);
	};
	const getOriginalMessage = async (decodedForm: Record<any, any>) => {
		const [message] = await db
			.select({
				message: messages,
				mailbox: mailboxes,
				identity: identities,
				provider: providers,
				smtpAccount: smtpAccounts,
			})
			.from(messages)
			.leftJoin(mailboxes, eq(messages.mailboxId, mailboxes.id))
			.leftJoin(identities, eq(mailboxes.identityId, identities.id))
			.leftJoin(providers, eq(identities.providerId, providers.id))
			.leftJoin(smtpAccounts, eq(identities.smtpAccountId, smtpAccounts.id))
			.where(eq(messages.id, String(decodedForm.originalMessageId)));

		return message;
	};

	type GetOriginalMessageType = Awaited<ReturnType<typeof getOriginalMessage>>;

	async function ensureThreadId(ownerId: string, workspaceId: string, tx: PgTransaction<any>) {
		const [t] = await tx
			.insert(threads)
			.values({
				ownerId,
				workspaceId,
				lastMessageDate: new Date(),
			})
			.returning({ id: threads.id });
		return t.id;
	}

	function toAddressObj(
		input: string | string[] | null | undefined,
	): AddressObjectJSON {
		const str = Array.isArray(input) ? input.join(",") : input || "";
		const parsed = addressparser(str);
		const value = parsed.map((p) => ({
			address: p.address || null,
			name: p.name || "",
		}));
		const joined = value
			.map((v: { name: any; address: any }) =>
				v.name ? `${v.name} <${v.address ?? ""}>` : (v.address ?? ""),
			)
			.join(", ");
		return { value, html: joined, text: joined };
	}

	// ss2i : Boite d'envoi (OI 10519). L'ancien sendTx (tout dans une transaction, SMTP compris)
	// est decoupe : renderSend (lectures seules, hors transaction), SMTP dans le pipeline, puis
	// finalizeIo (copie Envoyes idempotente, effets apres le commit). Ordre : lib/send/pipeline.ts.

	// Pieces jointes telechargees au rendu, reprises pour l'eml de la copie Envoyes (retirees a la
	// fin du job ; une finalisation par le balayage les relit dans S3).
	const attachmentCache = new Map<string, AttachmentDownload[]>();

	const renderSend = async (row: LedgerRow): Promise<Prepared> => {
		const decodedForm = row.payload as Record<string, unknown>;
		const [mailbox] = await db
			.select({
				mailbox: mailboxes,
				identity: identities,
				provider: providers,
				smtp: smtpAccounts,
			})
			.from(mailboxes)
			.leftJoin(identities, eq(mailboxes.identityId, identities.id))
			.leftJoin(providers, eq(identities.providerId, providers.id))
			.leftJoin(smtpAccounts, eq(identities.smtpAccountId, smtpAccounts.id))
			.where(eq(mailboxes.id, String(decodedForm.sentMailboxId)));

		if (!mailbox) {
			throw new Error("Mailbox not found");
		}

		const [secrets] = mailbox.identity.providerId
			? await decryptAdminSecrets({
				linkTable: providerSecrets,
				foreignCol: providerSecrets.providerId,
				secretIdCol: providerSecrets.secretId,
				ownerId: mailbox.identity.ownerId,
				parentId: String(mailbox.identity.providerId),
			})
			: await decryptAdminSecrets({
				linkTable: smtpAccountSecrets,
				foreignCol: smtpAccountSecrets.accountId,
				secretIdCol: smtpAccountSecrets.secretId,
				ownerId: mailbox.identity.ownerId,
				parentId: String(mailbox.identity.smtpAccountId),
			});

		const credentials = secrets?.vault?.decrypted_secret
			? JSON.parse(secrets.vault.decrypted_secret)
			: {};

		const mailer = createMailer(
			mailbox.provider ? mailbox.provider.type : "smtp",
			credentials,
		);

		const attachmentBlobs = await fetchAttachmentBlobs(
			decodedForm.attachments as string,
			{
				workspaceId: mailbox.mailbox.workspaceId,
				identityOwnerId: mailbox.identity.ownerId,
				senderUserId: String(decodedForm.senderUserId ?? "") || null,
			},
		);

		const data: MailComposeInput = {
			messageId: String(decodedForm.messageId ?? ""),
			to: toArray(decodedForm.to as any),
			cc: toArray(decodedForm.cc as any),
			bcc: toArray(decodedForm.bcc as any),
			subject: (decodedForm.subject as string) || undefined,
			text: (decodedForm.text as string) || undefined,
			html: (decodedForm.html as string) || undefined,
			mode: (decodedForm.mode as ComposeMode) || "new",
		};

		let origRow: GetOriginalMessageType | null = null;
		if (
			(data.mode === "reply" || data.mode === "forward") &&
			decodedForm.originalMessageId
		) {
			origRow = await getOriginalMessage(decodedForm);
			// ss2i (controle d'acces) : un message d'origine d'un autre workspace est ignore
			// (ni citation, ni rattachement au fil, ni In-Reply-To) ; une reponse sans
			// message d'origine est refusee plus bas, comme un message introuvable.
			if (origRow?.message && !originalUsableBy(origRow.message, mailbox.mailbox)) {
				console.warn(
					`[send-mail] original message ${origRow.message.id} is not in workspace ${mailbox.mailbox.workspaceId}: ignored`,
				);
				origRow = null;
			}
		}

		const signatureHtml =
			decodedForm.includeSignature !== "false"
				? String((mailbox.identity.metaData as any)?.signatureHtml ?? "").trim()
				: "";
		// Signature demandee mais vide pour cette identite (Settings > General > Signature
		// est par identite) : on le dit dans le journal, pour ne pas chercher un bug.
		if (decodedForm.includeSignature !== "false" && !signatureHtml) {
			console.warn(
				`[send-mail] identity ${mailbox.identity.value} (${mailbox.identity.id}) has no signature: sending without one`,
			);
		}

		// ss2i : style RFC (reponse sous la citation, « -- » devant la signature), option
		// de l'utilisateur qui envoie (workspaces.meta.ss2iRfcStyle[userId], cf.
		// apps/web/lib/actions/rfc-style.ts). Portee de la citation choisie dans l'editeur ;
		// absente (job deja en file) = message entier.
		const senderUserId =
			String(decodedForm.senderUserId ?? "") || mailbox.identity.ownerId;
		const rfcStyle = await rfcStyleEnabled(mailbox.mailbox.workspaceId, senderUserId);
		const quoteScope = quoteScopeOf(decodedForm.quoteScope);
		// Citation modifiee dans l'editeur (quoteMode custom + quoteHtml) ou supprimee (none).
		const quoteOverride = quoteOverrideOf(decodedForm.quoteMode, decodedForm.quoteHtml);

		const { subject, text, html } = generateMailAttrs({
			data,
			orig: origRow,
			signatureHtml,
			rfcStyle,
			quoteScope,
			quoteOverride,
		});

		// ss2i : un transfert reste dans le fil du message transfere (comme une reponse),
		// sinon il n'apparait nulle part sous le message d'origine ; il porte aussi
		// In-Reply-To et References, comme Gmail et Thunderbird. Sans fil d'origine, le fil
		// est cree a la finalisation (copie Envoyes), pas avant l'envoi.
		const threaded = data.mode === "reply" || data.mode === "forward";
		let threadId: string | null = null;
		if (data.mode === "reply") {
			if (!origRow?.message) throw new Error("Original message not found");
			threadId = origRow.message.threadId;
		} else if (data.mode === "forward" && origRow?.message?.threadId) {
			threadId = origRow.message.threadId;
		}

		const inReplyTo =
			threaded && origRow?.message
				? origRow.message.messageId
				: null;

		const references =
			threaded && origRow?.message
				? Array.from(
					new Set(
						[
							...(Array.isArray(origRow.message.references)
								? origRow.message.references
								: []),
							origRow.message.messageId ?? null,
						].filter(Boolean),
					),
				).slice(-30)
				: [];

		// ss2i : genre de mail automatique demande par la charge utile (« unsubscribe »).
		const autoMail = decodedForm.autoMail === "unsubscribe" ? "unsubscribe" : null;
		const from = mailbox.identity.value;
		const finalSubject = String(subject);
		attachmentCache.set(row.id, attachmentBlobs);
		return {
			from,
			imapDraftId: decodedForm.draftMessageId ? String(decodedForm.draftMessageId) : null,
			// Fige sur la ligne a l'acceptation : la copie Envoyes se rejoue depuis la ligne.
			rendered: {
				mailboxId: String(decodedForm.sentMailboxId),
				workspaceId: mailbox.mailbox.workspaceId,
				identityId: mailbox.mailbox.identityId,
				ownerId: mailbox.identity.ownerId,
				senderUserId: String(decodedForm.senderUserId ?? "") || null,
				from,
				to: data.to ?? [],
				cc: data.cc ?? [],
				bcc: data.bcc ?? [],
				subject: finalSubject,
				text: text ?? "",
				html: html ?? "",
				// En style RFC le texte commence par la citation : l'extrait reste la reponse.
				snippet: generateSnippet((rfcStyle && data.text) || text || html || ""),
				threadId,
				inReplyTo,
				references,
				attachments: attachmentBlobs.map((att) => att.item),
				autoMail,
				apiMessageId: decodedForm.apiMessageId ? String(decodedForm.apiMessageId) : null,
			},
			send: (messageId) =>
				mailer.sendEmail(data.to, {
					messageId,
					from,
					cc: data.cc ?? [],
					bcc: data.bcc ?? [],
					subject: finalSubject,
					text: text ?? "",
					html: html ?? "",
					inReplyTo: inReplyTo ?? "",
					references: references,
					extraHeaders: autoMail ? { [AUTO_MAIL_HEADER]: autoMail } : undefined,
					attachments: attachmentBlobs.map((att) => ({
						name: att.name,
						content: att.blob,
						contentType: String(att.item.contentType),
					})),
				}),
		};
	};

	const finalizeIo: FinalizeIo = {
		transaction: (fn) =>
			db.transaction((tx) =>
				fn({
					lockRow: (id) => lockLedgerRow(tx, id),
					ensureThread: async (row) =>
						row.rendered?.threadId
							? String(row.rendered.threadId)
							: ensureThreadId(String(row.rendered!.ownerId), String(row.rendered!.workspaceId), tx as PgTransaction<any>),
					insertMessage: async (row, threadId) => {
						const r = row.rendered!;
						const parsed = MessageInsertSchema.parse({
							mailboxId: String(r.mailboxId),
							workspaceId: String(r.workspaceId),
							threadId,
							messageId: String(row.messageId),
							inReplyTo: r.inReplyTo ?? undefined,
							references: r.references ?? [],
							hasAttachments: (r.attachments ?? []).length > 0,
							to: toAddressObj(r.to || []),
							from: String(r.from),
							cc: toAddressObj(r.cc || []),
							bcc: toAddressObj(r.bcc || []),
							snippet: String(r.snippet ?? ""),
							subject: r.subject,
							text: r.text,
							html: r.html,
							ownerId: String(r.ownerId),
							seen: true,
						});
						if (r.apiMessageId) parsed.id = String(r.apiMessageId);
						// Copie IMAP de Envoyes arrivee avant (meme Message-ID) : reprise telle quelle.
						const [created] = await tx
							.insert(messages)
							.values(parsed as MessageCreate)
							.onConflictDoNothing({ target: [messages.mailboxId, messages.messageId] })
							.returning({ id: messages.id });
						if (created) return { id: created.id, inserted: true };
						const [existing] = await tx
							.select({ id: messages.id })
							.from(messages)
							.where(and(eq(messages.mailboxId, String(r.mailboxId)), eq(messages.messageId, String(row.messageId))))
							.limit(1);
						if (!existing) throw new Error("Sent copy neither inserted nor found");
						return { id: existing.id, inserted: false };
					},
					insertAttachments: async (messageRowId, row) => {
						for (const item of row.rendered?.attachments ?? []) {
							await tx
								.insert(messageAttachments)
								.values({
									...MessageAttachmentInsertSchema.parse(item),
									ownerId: String(row.rendered!.ownerId),
									workspaceId: String(row.rendered!.workspaceId),
									messageId: messageRowId,
								})
								.onConflictDoNothing();
						}
					},
					upsertThreadItem: (messageRowId) => upsertMailboxThreadItem(messageRowId, tx),
					setSentRowId: (id, messageRowId) =>
						tx.update(draftMessages).set({ sentRowId: messageRowId, updatedAt: new Date() }).where(eq(draftMessages.id, id)),
				}),
			),
		// Effets non transactionnels, chacun isole : un echec ici ne fait jamais echouer un envoi
		// accepte par le serveur.
		afterCommit: async ({ row, messageRowId, inserted }) => {
			const r = row.rendered!;
			const step = async (label: string, fn: () => Promise<unknown>) => {
				try {
					await fn();
				} catch (err: any) {
					console.error(`[send-mail] ${row.id} ${label} failed:`, err?.message ?? err);
				}
			};
			await step("eml", async () => {
				const [msg] = await db
					.select({ ownerId: messages.ownerId, mailboxId: messages.mailboxId, rawStorageKey: messages.rawStorageKey })
					.from(messages)
					.where(eq(messages.id, messageRowId))
					.limit(1);
				if (!msg || msg.rawStorageKey) return;
				const blobs =
					attachmentCache.get(row.id) ??
					(await fetchAttachmentBlobs(JSON.stringify(r.attachments ?? []), {
						workspaceId: String(r.workspaceId),
						identityOwnerId: String(r.ownerId),
						senderUserId: r.senderUserId ?? null,
					}));
				const emlBuffer = await buildEmlBuffer({
					messageId: String(row.messageId),
					from: String(r.from),
					to: r.to || [],
					cc: r.cc || [],
					bcc: r.bcc || [],
					subject: String(r.subject || "(no subject)"),
					text: r.text,
					html: r.html,
					inReplyTo: r.inReplyTo,
					references: r.references,
					attachments: blobs,
				});
				const rawStorageKey = `eml/${msg.ownerId}/${msg.mailboxId}/${messageRowId}.eml`;
				await s3.send(
					new PutObjectCommand({
						Bucket: serverConfig.S3_BUCKET,
						Key: rawStorageKey,
						Body: emlBuffer,
						ContentType: "message/rfc822",
					}),
				);
				await db
					.update(messages)
					.set({ rawStorageKey, sizeBytes: emlBuffer.length })
					.where(and(eq(messages.id, messageRowId), isNull(messages.rawStorageKey)));
			});
			if (inserted) {
				await step("search", async () => {
					const { searchIngestQueue } = await getRedis();
					await searchIngestQueue.add("add", { messageId: messageRowId }, { removeOnComplete: true });
				});
				// ss2i clients : le fil rejoint (ou reste dans) le dossier client de ses destinataires
				// (pas pour un mail automatique de desinscription, X-Kurrier-Auto).
				await step("crm", async () => {
					const [msg] = await db
						.select({ threadId: messages.threadId })
						.from(messages)
						.where(eq(messages.id, messageRowId))
						.limit(1);
					if (!r.autoMail && msg?.threadId && r.identityId) {
						await enqueueCrmLinkByIdentity(msg.threadId, String(r.identityId));
					}
				});
				// ss2i : mail automatique (desinscription) : le destinataire n'entre ni au carnet ni
				// aux suggestions (la copie du dossier Envoyes est filtree par l'en-tete dans
				// message-parser-contacts.ts). Les destinataires rejoignent le carnet de l'expediteur.
				if (!r.autoMail) {
					const ownerIds = [String(r.senderUserId ?? ""), String(r.ownerId)].filter(Boolean);
					await step("contacts", () =>
						upsertContactsFromOutgoing({
							ownerIds,
							workspaceId: String(r.workspaceId),
							ownAddresses: [String(r.from)],
							recipients: [r.to, r.cc],
						}),
					);
					// ss2i : suggestions de destinataires (frecency et co-occurrence), To, Cc et Bcc.
					await step("recipient stats", () =>
						ingestRecipientStats({
							ownerIds,
							messageId: String(row.messageId),
							sentAt: row.acceptedAt ?? new Date(),
							ownAddresses: [String(r.from)],
							recipients: [r.to, r.cc, r.bcc],
						}),
					);
				}
			}
			// ss2i : un envoi parti d'un brouillon le supprime (base, puis IMAP par le job
			// draft:delete). Un envoi annule ou en echec le laisse en place.
			const draftMessageId = row.payload?.draftMessageId;
			if (draftMessageId) {
				await step("draft cleanup", async () => {
					const [ident] = await db
						.select({ id: identities.id, ownerId: identities.ownerId })
						.from(identities)
						.where(eq(identities.id, String(row.payload?.identityId ?? row.identityId ?? "")));
					if (ident) {
						await deleteDraft({
							ownerId: ident.ownerId,
							identityId: ident.id,
							draftMessageId: String(draftMessageId),
							afterSend: true,
						});
					}
				});
			}
		},
	};

	const sendDeps: SendDeps = {
		store: ledgerStore,
		render: renderSend,
		newMessageId: (from) => messageIdFor(from, randomUUID()),
		finalize: (rowId) => finalizeSent(rowId, finalizeIo),
		// Fin d'envoi en echec : la marque « envoi en cours » est retiree et l'erreur gardee sur le
		// brouillon (badge « Non envoye ») ; la ligne reste dans la Boite d'envoi.
		markFailed: async (row, error) => {
			const draftMessageId = row.payload?.draftMessageId;
			if (!draftMessageId) return;
			await setDraftSendState(
				String(draftMessageId),
				{ pendingSend: null, sendError: { message: draftSendErrorOf(row, error), at: new Date().toISOString() } },
				{ ifJobId: row.id },
			);
		},
		// Marque orpheline (balayage) : brouillon d'un envoi parti supprime comme apres l'envoi ;
		// sinon marque retiree, et l'erreur d'un echec encore dans la Boite d'envoi revient sur le
		// brouillon comme avec markFailed.
		settleDraft: async (o, action) => {
			if (action === "delete") {
				await deleteDraft({
					ownerId: o.ownerId,
					identityId: String(o.identityId ?? ""),
					draftMessageId: o.draftId,
					afterSend: true,
					ifJobId: o.rowId,
				});
				return;
			}
			const failed = o.status === "failed" && !o.dismissedAt && o.lastError;
			await setDraftSendState(
				o.draftId,
				failed
					? { pendingSend: null, sendError: { message: draftSendErrorOf(o, o.lastError), at: new Date().toISOString() } }
					: { pendingSend: null },
				{ ifJobId: o.rowId },
			);
		},
		log: (msg, err) => console.error(`[send-mail] ${msg}`, (err as any)?.message ?? err ?? ""),
	};

	// Job herite « send-and-reconcile » : identite, proprietaire et workspace tires du dossier
	// Envoyes de la charge utile (le worker n'a pas de session RLS pour les valeurs par defaut).
	const legacyRowOf = async (job: Job) => {
		const data = (job.data ?? {}) as Record<string, any>;
		const [mb] = await db
			.select({
				identityId: identities.id,
				ownerId: identities.ownerId,
				workspaceId: mailboxes.workspaceId,
				value: identities.value,
			})
			.from(mailboxes)
			.innerJoin(identities, eq(mailboxes.identityId, identities.id))
			.where(eq(mailboxes.id, String(data.sentMailboxId ?? "")))
			.limit(1);
		if (!mb) throw new Error("Mailbox not found");
		return legacyLedgerRow(
			{ id: job.id, timestamp: job.timestamp, data },
			{ identityId: mb.identityId, fromAddress: mb.value },
			{
				findByLegacyKey,
				insertRow: async (v) => {
					const [created] = await db
						.insert(draftMessages)
						.values({ ...v, ownerId: mb.ownerId, workspaceId: mb.workspaceId })
						.returning({ id: draftMessages.id });
					return created;
				},
				newMessageId: (from) => messageIdFor(from, randomUUID()),
			},
		);
	};

	// Option « style RFC » de l'utilisateur qui envoie, lue dans le meta du workspace
	// (meme rangement que les autres options par utilisateur : ss2iUnreadPanel, ss2iListPreview).
	async function rfcStyleEnabled(workspaceId: string, userId: string) {
		try {
			const [row] = await db
				.select({
					on: sql<boolean>`coalesce((${workspaces.metaData}->'ss2iRfcStyle'->>${userId}::text)::boolean, false)`,
				})
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.limit(1);
			return Boolean(row?.on);
		} catch (err: any) {
			console.error("[send-mail] rfc style lookup failed:", err?.message ?? err);
			return false;
		}
	}

	// Objet, texte et HTML du message a envoyer : l'assemblage (citation, signature,
	// ordre) est dans packages/common/src/compose.ts, partage avec l'editeur web.
	const generateMailAttrs = ({
		data,
		orig,
		signatureHtml,
		rfcStyle,
		quoteScope,
		quoteOverride,
	}: {
		data: MailComposeInput;
		orig: GetOriginalMessageType | null;
		signatureHtml?: string;
		rfcStyle: boolean;
		quoteScope: QuoteScope;
		quoteOverride: QuoteOverride;
	}) => {
		const origMsg = orig?.message ?? null;

		// Prefer RFC822 Date, then createdAt, else empty
		const rawDate: Date | null =
			origMsg && (origMsg.date ?? origMsg.createdAt)
				? (origMsg.date ?? origMsg.createdAt)!
				: null;

		// Dans le fuseau des utilisateurs (MAIL_TIMEZONE), pas celui du conteneur (UTC).
		const origDateLabel = formatQuoteDate(rawDate, serverConfig.MAIL_TIMEZONE);

		return composeMessage({
			mode: data.mode,
			subject: data.subject,
			text: data.text,
			html: data.html,
			signatureHtml,
			rfcStyle,
			quoteScope,
			quoteOverride,
			orig: origMsg
				? {
					html: origMsg.html,
					text: origMsg.text,
					textAsHtml: origMsg.textAsHtml,
					subject: origMsg.subject,
					fromName: getMessageName(origMsg, "from") || "",
					fromAddress: getMessageAddress(origMsg, "from") || "",
					dateLabel: origDateLabel,
				}
				: null,
		});
	};


	async function streamToBuffer(stream: any): Promise<Buffer> {
		return await new Promise((resolve, reject) => {
			const chunks: any[] = [];
			stream.on("data", (chunk: any) => chunks.push(chunk));
			stream.on("error", reject);
			stream.on("end", () => resolve(Buffer.concat(chunks)));
		});
	}

	async function fetchAttachmentBlobs(
		attachmentsString: string,
		owner: Parameters<typeof allowedAttachmentKeys>[1],
	): Promise<AttachmentDownload[]> {
		let attachments: unknown = [];
		try {
			attachments = attachmentsString ? JSON.parse(attachmentsString) : [];
		} catch {
			return [];
		}

		const list = Array.isArray(attachments) ? attachments : [];
		const candidates = list.filter((a: any) => a && a.path);

		if (candidates.length === 0) return [];

		// ss2i (controle d'acces) : seulement des cles de l'expediteur ou des pieces jointes de
		// son workspace ; une autre cle fait echouer l'envoi (avant : n'importe quel objet du
		// bucket partait en piece jointe).
		const allowed = await allowedAttachmentKeys(
			candidates.map((a: any) => String(a.path)),
			owner,
		);
		const refused = candidates.filter((a: any) => !allowed.has(String(a.path)));
		if (refused.length) {
			throw new Error(
				`Attachment not allowed: ${refused.map((a: any) => String(a.filenameOriginal ?? a.path)).join(", ")}`,
			);
		}

		try {
			const downloads = await Promise.all(
				candidates.map(async (attachment: any): Promise<AttachmentDownload> => {
					const command = new GetObjectCommand({
						Bucket: serverConfig.S3_BUCKET,
						Key: String(attachment.path),
					});

					const response = await s3.send(command);

					if (!response.Body) {
						throw new Error(`Failed to download "${attachment.path}"`);
					}

					const buffer = await streamToBuffer(response.Body);

					const item = MessageAttachmentInsertSchema.parse(attachment);
					const uint8 = new Uint8Array(buffer);

					return {
						item,
						blob: new Blob([uint8], {
							type: String(attachment.contentType || "application/octet-stream"),
						}),
						name: String(attachment.filenameOriginal || "attachment"),
						sizeBytes: buffer.length,
					};
				}),
			);

			return downloads;
		} catch (e) {
			console.error("fetchAttachmentBlobs error:", e);
			return [];
		}
	}


	async function blobToBuffer(blob: Blob) {
		return Buffer.from(await blob.arrayBuffer());
	}

	async function buildEmlBuffer(opts: {
		messageId: string;
		from: string;
		to: string[];
		cc?: string[];
		bcc?: string[];
		subject: string;
		text?: string | null;
		html?: string | null;
		inReplyTo?: string | null;
		references?: string[];
		attachments: AttachmentDownload[];
	}) {
		const composer = new MailComposer({
			messageId: opts.messageId,
			from: opts.from,
			to: opts.to,
			cc: opts.cc,
			bcc: opts.bcc,
			subject: opts.subject,
			text: opts.text || "",
			html: opts.html || "",
			inReplyTo: opts.inReplyTo || undefined,
			references: opts.references?.length ? opts.references : undefined,
			attachments: await Promise.all(
				opts.attachments.map(async (att) => ({
					filename: att.name,
					content: await blobToBuffer(att.blob),
					contentType: String(att.item.contentType || "application/octet-stream"),
				})),
			),
		});

		return await new Promise<Buffer>((resolve, reject) => {
			composer.compile().build((err, message) => {
				if (err) reject(err);
				else resolve(message);
			});
		});
	}

	// Reprise des envois programmes au demarrage, puis balayage du ledger (envois interrompus,
	// copies Envoyes en retard), au demarrage et toutes les 5 minutes.
	const sweep = () =>
		sweepLedger(sendDeps)
			.then(({ interrupted, finalized, settled }) => {
				if (interrupted.length || finalized.length || settled.length) {
					console.warn(`[send-mail] ledger sweep: interrupted ${interrupted.join(", ") || "-"}, finalized ${finalized.join(", ") || "-"}, drafts settled ${settled.join(", ") || "-"}`);
				}
			})
			.catch((e: any) => console.error("[send-mail] ledger sweep failed:", e?.message ?? e));
	rehydrateScheduled()
		.catch((e: any) => console.error("[send-mail] scheduled restore failed:", e?.message ?? e))
		.finally(sweep);
	const sweepTimer = setInterval(sweep, 5 * 60_000);

	nitroApp.hooks.hookOnce("close", async () => {
		console.log("Closing nitro server...");
		console.log("Task is done!");
		clearInterval(sweepTimer);
		try {
			await worker.close();
		} catch (err: any) {
			console.error("Error closing send mail worker:", err?.message ?? err);
		}
	});
});
