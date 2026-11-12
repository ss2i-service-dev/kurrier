// ss2i : lecture d'un champ from/to/cc/bcc tel que range dans messages. Deux formes en base :
// l'objet mailparser ({ value: [{ name, address }], text, html }) des messages recus, et une
// simple chaine (« a@b » ou « "Nom" <a@b>, c@d ») pour ceux envoyes depuis kurrier. Lire
// seulement `value` laissait l'expediteur des envoyes vide (copie presse-papiers en 0097, liste
// des fils le 12/11 : « il y a une case vide sur deux mails »).
export type ParsedAddress = { name: string | null; address: string };

const splitList = (raw: string): string[] =>
	(raw.match(/(?:"[^"]*"|[^,])+/g) ?? []).map((part) => part.trim()).filter(Boolean);

const parseOne = (part: string): ParsedAddress | null => {
	const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
	if (m) {
		const address = m[2].trim();
		return address ? { name: m[1].trim() || null, address } : null;
	}
	return part.includes("@") ? { name: null, address: part.trim() } : null;
};

export function parseAddressField(v: unknown): ParsedAddress[] {
	if (!v) return [];
	if (typeof v === "object" && Array.isArray((v as any).value)) {
		return (v as any).value
			.map((a: any) => ({ name: a?.name || null, address: a?.address || "" }))
			.filter((a: ParsedAddress) => a.address);
	}
	const raw = typeof v === "string" ? v : typeof (v as any).text === "string" ? (v as any).text : "";
	return splitList(raw)
		.map(parseOne)
		.filter((a): a is ParsedAddress => !!a);
}
