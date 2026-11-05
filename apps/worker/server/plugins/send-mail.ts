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
import { toArray } from "drizzle-orm/mysql-core";
import { and, eq, sql } from "drizzle-orm";
import addressparser from "addressparser";
import { PgTransaction } from "drizzle-orm/pg-core";
import { getRedis } from "../../lib/get-redis";
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
					// A provider refusal returned as a value (not thrown) counts as a failure.
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
		// Final failure of a send coming from a draft: the "sending" mark is removed and the
		// error kept on the draft ("Not sent" badge).
		const draftMessageId = (job?.data as any)?.draftMessageId;
		if (
			job?.name === "send-and-reconcile" &&
			draftMessageId &&
			job.attemptsMade >= (job.opts?.attempts ?? 1)
		) {
			setDraftSendState(String(draftMessageId), {
				pendingSend: null,
				sendError: { message: err?.message ?? "Sending failed", at: new Date().toISOString() },
			}).catch((e: any) =>
				console.error("[send-mail] sendError mark failed:", e?.message ?? e),
			);
		}
	});

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
			await send(draft.payload);

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

	// A send that started from a draft deletes it (database, then IMAP through the
	// draft:delete job). A cancelled or failed send leaves it in place.
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
				// Access control: an original message from another workspace is ignored (no quote, no
				// thread attachment, no In-Reply-To); a reply without an original message is refused
				// further down, like a message not found.
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
			// Signature requested but empty for this identity (Settings > General > Signature is
			// per identity): say so in the log, so nobody goes looking for a bug.
			if (decodedForm.includeSignature !== "false" && !signatureHtml) {
				console.warn(
					`[send-mail] identity ${mailbox.identity.value} (${mailbox.identity.id}) has no signature: sending without one`,
				);
			}

			// RFC style (reply below the quote, "-- " before the signature), an option of the sending
			// user (workspaces.meta.prefRfcStyle[userId], see apps/web/lib/actions/rfc-style.ts).
			// Scope of the quote chosen in the editor; absent (job already queued) = whole message.
			const senderUserId =
				String(decodedForm.senderUserId ?? "") || mailbox.identity.ownerId;
			const rfcStyle = await rfcStyleEnabled(mailbox.mailbox.workspaceId, senderUserId);
			const quoteScope = quoteScopeOf(decodedForm.quoteScope);
			// Quote edited in the editor (quoteMode custom + quoteHtml) or removed (none).
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

			// A forward stays in the thread of the forwarded message (like a reply), otherwise it
			// appears nowhere under the original message; it also carries In-Reply-To and References,
			// like Gmail and Thunderbird.
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
				// In RFC style the text starts with the quote: the snippet stays the reply.
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

			// Kind of automatic mail requested by the payload ("unsubscribe").
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
				// Automatic mail (unsubscribe): the recipient enters neither the address book nor the
				// suggestions (the Sent folder copy is filtered by the header in
				// message-parser-contacts.ts).
				const skipRecipientStats = !!autoMail;
				// Recipients join the sender's address book. Never blocking: a failure here must not make
				// a successful send fail.
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
				// Recipient suggestions (frecency and co-occurrence), To, Cc and Bcc.
				if (!skipRecipientStats) await ingestRecipientStats({
					ownerIds: [String(decodedForm.senderUserId ?? ""), newMessage.ownerId].filter(Boolean),
					messageId: String(parsedMessage.messageId),
					sentAt: newMessage.date ?? newMessage.createdAt ?? null,
					ownAddresses: [mailbox.identity.value],
					recipients: [data.to, data.cc, data.bcc],
				});
			} else if (mailerResponse.error) {
				return {
					success: false,
					error: `Failed to send email: ${mailerResponse.error}`,
				};
			}
			return { success: true };
		});
	};

	// The sending user's "RFC style" option, read from the workspace meta (same layout as the
	// other per-user options: prefUnreadPanel, prefListPreview).
	async function rfcStyleEnabled(workspaceId: string, userId: string) {
		try {
			const [row] = await db
				.select({
					on: sql<boolean>`coalesce((${workspaces.metaData}->'prefRfcStyle'->>${userId}::text)::boolean, false)`,
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

	// Subject, text and HTML of the message to send: the assembly (quote, signature, order) is
	// in packages/common/src/compose.ts, shared with the web editor.
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

		// In the users' time zone (MAIL_TIMEZONE), not the container's (UTC).
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

		// Access control: only keys of the sender or attachments of their workspace; any other
		// key makes the send fail (otherwise any object in the bucket could go out as an attachment).
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
