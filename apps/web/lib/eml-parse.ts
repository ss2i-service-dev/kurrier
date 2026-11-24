// ss2i : decodage d'un mail joint (.eml) pour la visionneuse, voir lib/eml-preview.ts.
// Serveur seulement (mailparser). Teste par apps/web/test/eml-preview.ts.
import { simpleParser, type AddressObject, type Attachment, type EmailAddress, type ParsedMail } from "mailparser";
import {
	EML_INLINE_MAX_BYTES,
	emlPartName,
	type EmlAddress,
	type EmlAddressField,
	type EmlPreviewData,
} from "./eml-preview";
import { isMsgFile, msgPart, parseMsgPreview } from "./msg-parse";

const parse = (source: Buffer) =>
	// Pas de conversion du texte en HTML : le lecteur rend deja le texte seul proprement.
	// keepCidLinks : mailparser incrusterait sinon toutes les images inline, sans limite de
	// taille ; inlineImages() les resout dans la limite d'EML_INLINE_MAX_BYTES.
	simpleParser(source, { skipTextToHtml: true, skipTextLinks: true, keepCidLinks: true });

function flatten(list: EmailAddress[], out: EmlAddress[]) {
	for (const a of list) {
		if (a.group?.length) flatten(a.group, out);
		else if (a.address || a.name) out.push({ name: a.name || null, address: a.address || null });
	}
}

function addresses(field: AddressObject | AddressObject[] | undefined): EmlAddressField {
	if (!field) return null;
	const out: EmlAddress[] = [];
	for (const o of Array.isArray(field) ? field : [field]) flatten(o.value ?? [], out);
	return out.length ? { value: out } : null;
}

const cidOf = (a: Attachment) => (a.contentId || a.cid || "").replace(/^<|>$/g, "").trim().toLowerCase();

// Images inline reellement citees dans le HTML (cid:...), converties en data:.
function inlineImages(parsed: ParsedMail) {
	const html = typeof parsed.html === "string" ? parsed.html.toLowerCase() : "";
	const cidUrls: Record<string, string> = {};
	const used = new Set<Attachment>();
	let budget = EML_INLINE_MAX_BYTES;
	for (const a of parsed.attachments) {
		const cid = cidOf(a);
		const type = (a.contentType || "").toLowerCase();
		if (!cid || !type.startsWith("image/") || !html.includes(`cid:${cid}`)) continue;
		// Une image inline trop lourde reste dans la liste, telechargeable.
		if (a.size > budget) continue;
		budget -= a.size;
		cidUrls[cid] = `data:${type};base64,${a.content.toString("base64")}`;
		used.add(a);
	}
	return { cidUrls, used };
}

export async function parseEmlPreview(source: Buffer): Promise<EmlPreviewData> {
	// Mail Outlook (.msg) : reconnu a sa signature CFBF, quel que soit son nom.
	if (isMsgFile(source)) return parseMsgPreview(source);
	const parsed = await parse(source);
	const { cidUrls, used } = inlineImages(parsed);
	return {
		subject: parsed.subject ?? null,
		date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.toISOString() : null,
		from: addresses(parsed.from),
		to: addresses(parsed.to),
		cc: addresses(parsed.cc),
		replyTo: addresses(parsed.replyTo),
		html: typeof parsed.html === "string" && parsed.html.trim() ? parsed.html : null,
		text: parsed.text ?? null,
		cidUrls,
		attachments: parsed.attachments
			.map((a, index) => ({ a, index }))
			.filter(({ a }) => !used.has(a))
			.map(({ a, index }) => {
				const contentType = (a.contentType || "application/octet-stream").toLowerCase();
				return { index, filename: emlPartName(a.filename, contentType, index), contentType, size: a.size };
			}),
	};
}

// Piece jointe interne n° index (meme numerotation que parseEmlPreview), ou null.
export async function emlPart(source: Buffer, index: number) {
	if (isMsgFile(source)) return msgPart(source, index);
	const parsed = await parse(source);
	const a = parsed.attachments[index];
	if (!a) return null;
	const contentType = (a.contentType || "application/octet-stream").toLowerCase();
	return { filename: emlPartName(a.filename, contentType, index), content: a.content };
}
