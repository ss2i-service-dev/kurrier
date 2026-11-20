// ss2i : citations repliées par défaut seulement quand on a déjà lu ce qu'elles contiennent
// (Samuel le 20/11/2026). Un message transféré, ou le premier message d'un fil chez nous
// (conversation à laquelle on n'a pas participé), s'affiche déplié ; une réponse dont les
// messages précédents sont affichés au-dessus garde ses citations repliées.

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
	// Index chronologique (0 = plus ancien) : rien au-dessus, donc rien de déjà lu.
	if (m.threadIndex === 0) return false;
	return true;
}
