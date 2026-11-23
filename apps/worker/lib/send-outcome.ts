// Any { success: false } from a sending provider is a failure, cause known or not.
// Before, send-mail.ts only tested `error`: a refusal without a cause (smtp, ses, sendgrid,
// mailgun) returned success:true, the draft was deleted with no copy in Sent and no error shown.
export const mailerFailureOf = (res: {
	success: boolean;
	error?: string;
	MessageId?: string;
}): string | null =>
	res.success
		? null
		: `Failed to send email: ${res.error || "refused by the sending server, no detail"}`;
