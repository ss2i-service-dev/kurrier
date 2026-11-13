// ss2i : tout { success: false } d'un fournisseur d'envoi est un echec, cause connue ou non.
// Avant, send-mail.ts ne testait que `error` : un refus sans cause (smtp, ses, sendgrid, mailgun)
// rendait success:true, le brouillon etait supprime sans copie dans Sent ni erreur affichee.
export const mailerFailureOf = (res: {
	success: boolean;
	error?: string;
	MessageId?: string;
}): string | null =>
	res.success
		? null
		: `Failed to send email: ${res.error || "refus du serveur d'envoi, sans detail"}`;
