// Quotes are folded by default only when what they contain has already been read. A forwarded
// message, or the first message of a thread on our side (a conversation we did not take part
// in), is displayed unfolded; a reply whose previous messages are displayed above keeps its
// quotes folded.

const FORWARD_SUBJECT = /^\s*(?:\[[^\]]*\]\s*)?(?:fwd?|fw|tr|wg|enc|rv)\s*:/i;
const FORWARD_MARKER =
	/forwarded message|begin forwarded message|message\s+transf(?:é|&eacute;|&#233;|e)r(?:é|&eacute;|&#233;|e)|-{2,}\s*original message|-{2,}\s*message d(?:'|’|&#39;|&rsquo;)origine/i;

export function isForwardedMessage(m: {
	subject?: string | null;
	html?: string | null;
	text?: string | null;
}): boolean {
	if (m.subject && FORWARD_SUBJECT.test(m.subject)) return true;
	return FORWARD_MARKER.test(m.html || "") || FORWARD_MARKER.test(m.text || "");
}

export function hideQuotesByDefault(m: {
	threadIndex?: number;
	subject?: string | null;
	html?: string | null;
	text?: string | null;
}): boolean {
	if (isForwardedMessage(m)) return false;
	// Chronological index (0 = oldest): nothing above, so nothing already read.
	if (m.threadIndex === 0) return false;
	return true;
}
