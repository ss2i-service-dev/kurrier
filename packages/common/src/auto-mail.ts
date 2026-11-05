// Mails sent automatically by the app (e.g. unsubscribe by mailto). They carry the
// X-Kurrier-Auto: <kind> header, which send-mail.ts adds when the payload asks for it.
// Neither the address book nor the recipient suggestions must learn anything from them,
// whether at send time or when the copy comes back through the Sent folder sync.
export const AUTO_MAIL_HEADER = "X-Kurrier-Auto";

// `headers`: mailparser Map (lowercase keys) or headers_json object; value is a string or
// an array of strings. Returns the kind ("unsubscribe") or null.
export function autoMailKind(
	headers: Map<string, any> | Record<string, any> | null | undefined,
): string | null {
	if (!headers) return null;
	const key = AUTO_MAIL_HEADER.toLowerCase();
	let v: any = headers instanceof Map ? headers.get(key) : (headers as any)[key];
	if (Array.isArray(v)) v = v[0];
	if (v && typeof v === "object") v = v.value ?? v.text ?? "";
	const s = String(v ?? "").trim().toLowerCase();
	return s || null;
}
