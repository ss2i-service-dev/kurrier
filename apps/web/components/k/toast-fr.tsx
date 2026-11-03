"use client";
// SS2i (Outlook) : notifications en francais. Les messages viennent souvent des
// actions serveur partagees avec l'interface Gmail (en anglais) : on ne touche
// pas au serveur, on traduit a l'affichage, en Outlook seulement, a partir du
// dictionnaire components/k/fr-messages.ts. Texte inconnu : laisse tel quel.
import { useEffect } from "react";
import { toast } from "sonner";
import { FR_EXACT, FR_PATTERNS } from "@/components/k/fr-messages";

export function translateFr(text: unknown): unknown {
	if (typeof text !== "string") return text;
	const t = text.trim();
	if (!t) return text;
	if (FR_EXACT[t]) return FR_EXACT[t];
	for (const [re, rep] of FR_PATTERNS) {
		const m = t.match(re);
		if (m) return typeof rep === "function" ? rep(...m) : t.replace(re, rep);
	}
	return text;
}

const METHODS = ["success", "error", "info", "warning", "message", "loading"] as const;
let installed = false;

function install() {
	if (installed) return;
	installed = true;
	const t = toast as any;
	const wrap = (fn: (...a: any[]) => any) =>
		(message: unknown, opts?: any) =>
			fn(
				translateFr(message),
				opts && typeof opts === "object"
					? {
							...opts,
							description: translateFr(opts.description),
							// boutons du toast (« Open Drafts », « Reload »...)
							action: opts.action?.label ? { ...opts.action, label: translateFr(opts.action.label) } : opts.action,
							cancel: opts.cancel?.label ? { ...opts.cancel, label: translateFr(opts.cancel.label) } : opts.cancel,
						}
					: opts,
			);
	for (const m of METHODS) {
		if (typeof t[m] === "function") t[m] = wrap(t[m].bind(t));
	}
}

/** Monte une fois en Outlook (voir ui-context) : traduit toutes les notifications. */
export default function KToastFr() {
	useEffect(() => {
		install();
	}, []);
	return null;
}
