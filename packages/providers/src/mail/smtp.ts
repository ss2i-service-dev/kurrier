import nodemailer, { type Transporter } from "nodemailer";
import {
	DomainIdentity,
	Mailer,
	RawSmtpConfigSchema,
	SendEmailResult,
	SmtpVerifyInput,
	VerifyResult,
} from "../core";
import { ImapFlow } from "imapflow";
import SMTPTransport from "nodemailer/lib/smtp-transport";

// ss2i (Boite d'envoi) : un echec SMTP est-il ambigu (message peut-etre parti) ? Non si le serveur
// a repondu par un code (refus certain, a n'importe quelle etape, DATA compris), si la connexion
// ou la resolution n'a jamais abouti, ou si l'authentification ou le TLS a echoue (avant DATA).
// Sinon oui : nodemailer etiquette « CONN » aussi bien une coupure avant MAIL FROM qu'une coupure
// apres le contenu, sans dire l'etape ; dans le doute, ambigu (confirmation avant de renvoyer).
export function smtpFailureAmbiguous(err: unknown): boolean {
	const e = (err ?? {}) as Record<string, any>;
	if (e.responseCode) return false;
	if (["EAUTH", "ENOAUTH", "EOAUTH2", "EDNS", "ETLS", "EENVELOPE"].includes(e.code)) return false;
	if (e.syscall === "connect" || e.syscall === "getaddrinfo") return false;
	if (e.code === "ETIMEDOUT" && /Connection timeout|Greeting never received/.test(String(e.message))) return false;
	if (e.code === "EMESSAGE" && (e.command === "API" || e.command === "MAIL FROM")) return false;
	return true;
}

export class SmtpMailer implements Mailer {
	private transporter: Transporter;
	private imapClient: ImapFlow | null;

	private constructor(cfg: SmtpVerifyInput) {
		this.transporter = nodemailer.createTransport({
			host: cfg.host,
			port: cfg.port,
			secure: cfg.secure ?? cfg.port === 465,
			auth: cfg.auth,
			pool: cfg.pool ?? false,
		} as SMTPTransport.Options);
		this.imapClient = cfg.imap
			? new ImapFlow({
					host: cfg.imap.host,
					port: cfg.imap.port,
					secure: cfg.imap.secure,
					auth: {
						user: cfg.imap.user,
						pass: cfg.imap.pass,
					},
				})
			: null;
	}

	static from(raw: unknown): SmtpMailer {
		const cfg = RawSmtpConfigSchema.parse(raw);
		return new SmtpMailer(cfg);
	}

	async verify(): Promise<VerifyResult> {
		const meta: Record<string, unknown> = { send: false, receive: undefined };

		try {
			const ok = await this.transporter.verify();
			meta.send = !!ok;

			if (this.imapClient) {
				try {
					await this.imapClient.connect();
					await this.imapClient.noop();
					meta.receive = true;
				} catch (err: any) {
					meta.receive = false;
					meta.response = err?.message ?? String(err);
				} finally {
					if (this.imapClient?.authenticated) {
						try {
							await this.imapClient.logout();
						} catch {}
					} else {
						try {
							await this.imapClient?.close();
						} catch {}
					}
				}
			}

			return { ok: true, message: "OK", meta };
		} catch (err: any) {
			return {
				ok: false,
				message: err?.message ?? "SMTP verify failed",
				meta: { code: err?.code, response: err?.response || err?.responseText },
			};
		} finally {
			try {
				(this.transporter as any).close?.();
			} catch {}
		}
	}

	async sendTestEmail(
		to: string,
		opts?: { subject?: string; body?: string },
	): Promise<boolean> {
		try {
			await this.transporter.sendMail({
				from: (this.transporter.options as any).auth.user,
				to,
				subject: opts?.subject ?? "Test email",
				text:
					opts?.body ?? "This is a test email from your configured provider.",
			});
			return true;
		} catch (err) {
			console.error("sendTestEmail error", err);
			return false;
		}
	}

	async addDomain(): Promise<DomainIdentity> {
		return {
			domain: "",
			status: "unverified",
			dns: [],
			meta: { info: "SMTP does not support domain identities" },
		};
	}

	async removeDomain(): Promise<DomainIdentity> {
		return {
			domain: "",
			status: "unverified",
			dns: [],
			meta: { info: "SMTP does not support domain identities" },
		};
	}

	async verifyDomain(): Promise<DomainIdentity> {
		return {
			domain: "",
			status: "unverified",
			dns: [],
			meta: { info: "SMTP does not support domain identities" },
		};
	}

	async addEmail() {
		return {} as any;
	}

	async removeEmail() {
		return {} as any;
	}

	async sendEmail(
		to: string[],
		opts: {
			subject: string;
			text: string;
			html: string;
			from: string;
			inReplyTo: string;
			references: string[];
			// ss2i : copies et copies cachees ; Bcc va dans l enveloppe SMTP, jamais dans les en-tetes.
			cc?: string[];
			bcc?: string[];
			// ss2i : en-tetes supplementaires (ex. X-Kurrier-Auto) ajoutes tels quels au message.
			extraHeaders?: Record<string, string>;
			attachments?: { name: string; content: Blob; contentType: string }[];
			messageId?: string;
		},
	): Promise<SendEmailResult> {
		try {
			// convert Blob attachments -> Nodemailer format (Buffer)
			const attachments = await Promise.all(
				(opts.attachments ?? []).map(async (a) => ({
					filename: a.name,
					content: Buffer.from(await a.content.arrayBuffer()),
					contentType: a.contentType || "application/octet-stream",
				})),
			);

			const headers: Record<string, string> = {};
			if (opts.inReplyTo) headers["In-Reply-To"] = opts.inReplyTo;
			if (opts.references?.length)
				headers["References"] = opts.references.join(" ");
			Object.assign(headers, opts.extraHeaders ?? {});

			const info = await this.transporter.sendMail({
				from: opts.from,
				to, // array is fine; Nodemailer will join
				cc: opts.cc?.length ? opts.cc : undefined,
				bcc: opts.bcc?.length ? opts.bcc : undefined,
				subject: opts.subject,
				text: opts.text || undefined,
				html: opts.html || undefined,
				headers,
				attachments,
				// ss2i : les images data: du HTML (logo ou carte de la signature) partent en pièces
				// jointes intégrées (cid), comme dans Outlook : une image distante serait bloquée par
				// défaut chez la plupart des destinataires.
				attachDataUrls: true,
				// ss2i (Boite d'envoi) : Message-ID fixe par courrier (ledger), sinon nodemailer le genere.
				...(opts.messageId ? { messageId: opts.messageId } : {}),
			});

			return {
				success: true,
				MessageId: String(info.messageId || ""),
				response: info.response ? String(info.response) : undefined,
			};
		} catch (err) {
			// ss2i : la cause remonte au worker (refus SMTP, erreur reseau), et si l'issue est inconnue.
			return {
				success: false,
				error: String((err as any)?.response || (err as any)?.message || String(err)),
				ambiguous: smtpFailureAmbiguous(err),
			};
		}
	}

	// async close(): Promise<void> {
	//     // best-effort close if transport supports it
	//     try {
	//         this.transporter.close?.();
	//     } catch { /* ignore */ }
	// }
}
