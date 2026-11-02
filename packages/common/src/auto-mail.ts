// ss2i : mails envoyes automatiquement par courrier (ex. desinscription par mailto). Ils portent
// l'en-tete X-Kurrier-Auto: <genre>, que send-mail.ts ajoute quand la charge utile le demande.
// Ni le carnet d'adresses ni les suggestions de destinataires ne doivent en apprendre quoi que
// ce soit, que ce soit a l'envoi ou quand la copie revient par la synchronisation du dossier Envoyes.
export const AUTO_MAIL_HEADER = "X-Kurrier-Auto";

// `headers` : Map mailparser (cles en minuscules) ou objet headers_json ; valeur chaine ou
// tableau de chaines. Rend le genre (« unsubscribe ») ou null.
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
