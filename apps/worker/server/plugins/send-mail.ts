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
	imapDraftIdOfJob,
	quoteOverrideOf,
	quoteScopeOf,
	rehydrateActionOf,
	scheduledJobOf,
	scheduledPendingSend,
	setDraftSendState,
	upsertMailboxThreadItem,
	type QuoteOverride,
	type QuoteScope,
} from "@common";
const serverConfig = getServerEnv();
import IORedis from "ioredis";
import { Worker } from "bullmq";
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
import { mailerFailureOf } from "../../lib/send-outcome";
import { toArray } from "drizzle-orm/mysql-core";
import { and, eq, lt, sql } from "drizzle-orm";
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
	const worker = new Worker(
		"send-mail",
		async (job) => {
			switch (job.name) {
				case "send-scheduled-draft":
					await processDraft(job.data);
					return { success: true };
				case "send-and-reconcile": {
					// Un refus du fournisseur rendu comme valeur (et non leve) compte comme un echec.
					const result = await send(job.data);
					if (result && (result as any).success === false) {
						throw new Error(String((result as any).error ?? "Sending failed"));
					}
					return { success: true };
				}
				default:
					return { success: true };
			}
		},
		{ connection },
	);

	worker.on("completed", (job) => {
		console.log(`[send-mail] ${job.id} completed`);
	});
	worker.on("failed", (job, err) => {
		console.error(`[send-mail] ${job?.id} failed: ${err?.message}`);
		// Echec definitif d'un envoi issu d'un brouillon (differe ou programme) : la marque
		// « envoi en cours » est retiree et l'erreur gardee sur le brouillon (badge « Not sent »).
		const draftMessageId = imapDraftIdOfJob(job?.name, job?.data as any);
		if (
			job &&
			draftMessageId &&
			job.attemptsMade >= (job.opts?.attempts ?? 1)
		) {
			setDraftSendState(draftMessageId, {
				pendingSend: null,
				sendError: { message: err?.message ?? "Sending failed", at: new Date().toISOString() },
			}).catch((e: any) =>
				console.error("[send-mail] sendError mark failed:", e?.message ?? e),
			);
		}
	});

	// ss2i : les envois programmes survivent a un redemarrage du worker ou a une perte de Redis :
	// chaque ligne « scheduled » retrouve son job (jobId = ligne, rejouer l'ajout est sans effet),
	// avec l'identite d'envoi dans les donnees (controle d'acces de « Annuler »). Une ligne restee
	// en « sending » depuis plus de 10 minutes est seulement signalee.
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
		const stuck = await db
			.select({ id: draftMessages.id })
			.from(draftMessages)
			.where(
				and(
					eq(draftMessages.status, "sending"),
					lt(draftMessages.updatedAt, new Date(Date.now() - 10 * 60_000)),
				),
			);
		if (stuck.length) {
			console.warn(
				`[send-mail] ${stuck.length} draft_messages row(s) in "sending" for over 10 min: ${stuck.map((r) => r.id).join(", ")}`,
			);
		}
		console.log(`[send-mail] scheduled sends: ${rows.length} pending, ${added} job(s) restored`);
	};
	rehydrateScheduled().catch((e: any) =>
		console.error("[send-mail] scheduled restore failed:", e?.message ?? e),
	);

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

	const processDraft = async ({
									draftMessageId,
								}: {
		draftMessageId: string;
	}) => {
		const [draft] = await db
			.select()
			.from(draftMessages)
			.where(eq(draftMessages.id, draftMessageId))
			.limit(1);

		if (!draft) throw new Error("Draft not found");

		const claimed = await db
			.update(draftMessages)
			.set({ status: "sending", updatedAt: new Date() })
			.where(
				and(
					eq(draftMessages.id, draft.id),
					eq(draftMessages.status, "scheduled"),
				),
			)
			.returning({ id: draftMessages.id });

		if (claimed.length === 0) return;

		try {
			// Un refus du fournisseur rendu comme valeur (et non leve) compte comme un echec.
			const result = await send(draft.payload);
			if (result && (result as any).success === false) {
				throw new Error(String((result as any).error ?? "Sending failed"));
			}

			await db
				.update(draftMessages)
				.set({ status: "sent", updatedAt: new Date() })
				.where(eq(draftMessages.id, draft.id));
		} catch (err: any) {
			await db
				.update(draftMessages)
				.set({
					status: "failed",
					payload: {
						...draft.payload,
						__error: err?.message ? String(err.message) : String(err),
					},
					updatedAt: new Date(),
				})
				.where(eq(draftMessages.id, draft.id));

			throw err;
		}
	};

	// ss2i : un envoi parti d'un brouillon le supprime (base, puis IMAP par le job
	// draft:delete). Un envoi annule ou en echec le laisse en place.
	const send = async (decodedForm: Record<any, unknown>) => {
		const result = await sendTx(decodedForm);
		if (result?.success && decodedForm.draftMessageId) {
			try {
				const [ident] = await db
					.select({ id: identities.id, ownerId: identities.ownerId })
					.from(identities)
					.where(eq(identities.id, String(decodedForm.identityId ?? "")));
				if (ident) {
					await deleteDraft({
						ownerId: ident.ownerId,
						identityId: ident.id,
						draftMessageId: String(decodedForm.draftMessageId),
						afterSend: true,
					});
				}
			} catch (err: any) {
				console.error("[send-mail] draft cleanup failed:", err?.message ?? err);
			}
		}
		return result;
	};

	const sendTx = async (decodedForm: Record<any, unknown>) => {
		return await db.transaction(async (tx) => {
			const [mailbox] = await tx
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

			const mailboxIdForMessage = String(decodedForm.sentMailboxId);

			let threadIdForMessage: string;

			// ss2i : un transfert reste dans le fil du message transfere (comme une reponse),
			// sinon il n'apparait nulle part sous le message d'origine ; il porte aussi
			// In-Reply-To et References, comme Gmail et Thunderbird.
			const threaded = data.mode === "reply" || data.mode === "forward";
			if (data.mode === "reply") {
				if (!origRow?.message) throw new Error("Original message not found");
				threadIdForMessage = origRow.message.threadId;
			} else if (data.mode === "forward" && origRow?.message?.threadId) {
				threadIdForMessage = origRow.message.threadId;
			} else {
				threadIdForMessage = await ensureThreadId(
					mailbox.identity.ownerId,
					mailbox.mailbox.workspaceId,
					tx as PgTransaction<any>,
				);
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

			const newMessageBody = MessageInsertSchema.parse({
				mailboxId: mailboxIdForMessage,
				workspaceId: mailbox.mailbox.workspaceId,
				threadId: threadIdForMessage,
				messageId: "PLACEHOLDER",
				inReplyTo: inReplyTo ?? undefined,
				references,
				hasAttachments: attachmentBlobs.length > 0,
				to: toAddressObj(data.to || []),
				from: mailbox.identity.value,
				cc: toAddressObj(data?.cc || []),
				bcc: toAddressObj(data.bcc || []),
				// En style RFC le texte commence par la citation : l'extrait reste la reponse.
				snippet: generateSnippet((rfcStyle && data.text) || text || html || ""),
				subject,
				text,
				html,
				ownerId: mailbox.identity.ownerId,
				seen: true,
			});
			if (decodedForm.apiMessageId) {
				newMessageBody.id = String(decodedForm.apiMessageId);
			}

			// ss2i : genre de mail automatique demande par la charge utile (« unsubscribe »).
			const autoMail = decodedForm.autoMail === "unsubscribe" ? "unsubscribe" : null;
			const mailerResponse = await mailer.sendEmail(data.to, {
				from: mailbox.identity.value,
				cc: data.cc ?? [],
				bcc: data.bcc ?? [],
				subject: String(newMessageBody.subject),
				text: newMessageBody.text ?? "",
				html: newMessageBody.html ?? "",
				inReplyTo: inReplyTo ?? "",
				references: references,
				extraHeaders: autoMail ? { [AUTO_MAIL_HEADER]: autoMail } : undefined,
				attachments: attachmentBlobs.map((att) => ({
					name: att.name,
					content: att.blob,
					contentType: String(att.item.contentType),
				})),
			});

			if (mailerResponse.success) {
				const parsedMessage = MessageInsertSchema.parse({
					...newMessageBody,
					messageId: String(mailerResponse.MessageId) || `msg-${Date.now()}`,
				});

				const [newMessage] = await tx
					.insert(messages)
					.values(parsedMessage as MessageCreate)
					.returning();


				const emlBuffer = await buildEmlBuffer({
					messageId: String(mailerResponse.MessageId) || `msg-${Date.now()}`,
					from: mailbox.identity.value,
					to: data.to || [],
					cc: data.cc || [],
					bcc: data.bcc || [],
					subject: String(newMessage.subject || "(no subject)"),
					text: newMessage.text,
					html: newMessage.html,
					inReplyTo,
					references,
					attachments: attachmentBlobs,
				});
				const rawStorageKey = `eml/${newMessage.ownerId}/${newMessage.mailboxId}/${newMessage.id}.eml`;
				await s3.send(
					new PutObjectCommand({
						Bucket: serverConfig.S3_BUCKET,
						Key: rawStorageKey,
						Body: emlBuffer,
						ContentType: "message/rfc822",
					}),
				);
				await tx
					.update(messages)
					.set({
						rawStorageKey,
						sizeBytes: emlBuffer.length,
					})
					.where(eq(messages.id, newMessage.id));




				for (const attachmentBlob of attachmentBlobs) {
					await tx.insert(messageAttachments).values({
						...attachmentBlob.item,
						ownerId: newMessage.ownerId,
						workspaceId: mailbox.mailbox.workspaceId,
						messageId: newMessage.id,
					});
				}

				await upsertMailboxThreadItem(newMessage.id, tx);

				const { searchIngestQueue } = await getRedis();
				await searchIngestQueue.add(
					"add",
					{ messageId: newMessage.id },
					{ removeOnComplete: true },
				);
				// ss2i clients : le fil rejoint (ou reste dans) le dossier client de ses destinataires
				// (pas pour un mail automatique de desinscription, X-Kurrier-Auto).
				if (!autoMail && newMessage.threadId && mailbox.mailbox.identityId) {
					await enqueueCrmLinkByIdentity(newMessage.threadId, mailbox.mailbox.identityId);
				}

				// ss2i : mail automatique (desinscription) : le destinataire n'entre ni au carnet ni
				// aux suggestions (la copie du dossier Envoyes est filtree par l'en-tete dans
				// message-parser-contacts.ts).
				const skipRecipientStats = !!autoMail;
				// Les destinataires rejoignent le carnet de l'expediteur. Jamais
				// bloquant : un echec ici ne doit pas faire echouer un envoi reussi.
				if (!skipRecipientStats) try {
					await upsertContactsFromOutgoing({
						ownerIds: [
							String(decodedForm.senderUserId ?? ""),
							mailbox.identity.ownerId,
						].filter(Boolean),
						workspaceId: mailbox.mailbox.workspaceId,
						ownAddresses: [mailbox.identity.value],
						recipients: [data.to, data.cc],
					});
				} catch (err: any) {
					console.error("[send-mail] outgoing contacts failed:", err?.message ?? err);
				}
				// ss2i : suggestions de destinataires (frecency et co-occurrence), To, Cc et Bcc.
				if (!skipRecipientStats) await ingestRecipientStats({
					ownerIds: [String(decodedForm.senderUserId ?? ""), newMessage.ownerId].filter(Boolean),
					messageId: String(parsedMessage.messageId),
					sentAt: newMessage.date ?? newMessage.createdAt ?? null,
					ownAddresses: [mailbox.identity.value],
					recipients: [data.to, data.cc, data.bcc],
				});
			} else {
				// ss2i : un refus sans cause reste un echec (lib/send-outcome.ts).
				return {
					success: false,
					error: mailerFailureOf(mailerResponse) as string,
				};
			}
			return { success: true };
		});
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

	nitroApp.hooks.hookOnce("close", async () => {
		console.log("Closing nitro server...");
		console.log("Task is done!");
		try {
			await worker.close();
		} catch (err: any) {
			console.error("Error closing send mail worker:", err?.message ?? err);
		}
	});
});
