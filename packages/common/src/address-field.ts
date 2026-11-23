// Reading of a from/to/cc/bcc field as stored in messages. Two shapes in the database: the
// mailparser object ({ value: [{ name, address }], text, html }) of received messages, and a
// plain string ("a@b" or "\"Name\" <a@b>, c@d") for those sent from kurrier. Reading only
// `value` left the sender of sent messages empty (blank sender in the thread list, copy to the
// clipboard).
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
