// ss2i : decodage d'un mail Outlook joint (.msg, format CFBF) pour la visionneuse, meme
// resultat que lib/eml-parse.ts pour un .eml (Hugo le 24/11/2026 : 218 .msg recus, aucun
// apercu). Lu par @kenjiuno/msgreader ; quand Outlook n'a garde le HTML que dans le RTF
// compresse (cas courant), il est decompresse puis desencapsule (rtf-stream-parser).
// Serveur seulement. Teste par apps/web/test/msg-preview.ts.
import MsgReader, { type FieldsData } from "@kenjiuno/msgreader";
import { decompressRTF } from "@kenjiuno/decompressrtf";
import iconv from "iconv-lite";
import { deEncapsulateSync } from "rtf-stream-parser";
import { effectiveType } from "./attachment-type";
import { EML_INLINE_MAX_BYTES, emlPartName, type EmlAddress, type EmlAddressField, type EmlPreviewData } from "./eml-preview";

// Signature d'un fichier CFBF (conteneur OLE2 des .msg).
export function isMsgFile(source: Uint8Array) {
	return source.length > 8 && source[0] === 0xd0 && source[1] === 0xcf && source[2] === 0x11 && source[3] === 0xe0;
}

// Adresse SMTP seulement : une adresse Exchange interne (/O=EXCHANGELABS/...) n'apprend rien.
const smtp = (...values: (string | undefined)[]) => values.find((v) => v && v.includes("@") && !v.startsWith("/")) ?? null;

function field(list: EmlAddress[]): EmlAddressField {
	return list.length ? { value: list } : null;
}

function htmlFromRtf(compressed: Uint8Array): string | null {
	try {
		const rtf = Buffer.from(decompressRTF(Array.from(compressed)));
		const result = deEncapsulateSync(rtf, {
			mode: "html",
			decode: (buf: Buffer, enc: string) => iconv.decode(buf, enc),
			encode: (str: string, enc: string) => iconv.encode(str, enc),
		});
		return result.mode === "html" ? String(result.text) : null;
	} catch {
		// RTF sans HTML encapsule (mail redige en RTF) : le texte brut suffit.
		return null;
	}
}

function bodyHtml(data: FieldsData): string | null {
	if (data.html?.length) return Buffer.from(data.html).toString("utf8");
	if (data.bodyHtml?.trim()) return data.bodyHtml;
	if (data.compressedRtf?.length) return htmlFromRtf(data.compressedRtf);
	return null;
}

function date(data: FieldsData) {
	const raw = data.messageDeliveryTime || data.clientSubmitTime;
	const d = raw ? new Date(raw) : null;
	return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

// Outlook n'enregistre souvent aucun type (attachMimeTag) : on se rabat sur l'extension.
const typeOf = (a: FieldsData) =>
	effectiveType(a.attachMimeTag, a.fileName || a.fileNameShort || a.extension) || "application/octet-stream";

// Images inline d'Outlook sans type ni extension : reconnues a leur signature.
export function sniffImage(bytes: Uint8Array): string | null {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
	if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
	return null;
}
const cidOf = (a: FieldsData) => (a.pidContentId || "").replace(/^<|>$/g, "").trim().toLowerCase();

function open(source: Buffer) {
	const reader = new MsgReader(new DataView(source.buffer, source.byteOffset, source.byteLength));
	const data = reader.getFileData();
	if (data.error) throw new Error(data.error);
	// Conteneur OLE2 qui n'est pas un mail (ou abime) : msgreader rend un objet vide sans erreur.
	if (!data.subject && !data.body && !data.html && !data.bodyHtml && !data.compressedRtf && !data.senderEmail && !data.recipients?.length)
		throw new Error("fichier .msg illisible");
	return { reader, data };
}

export function parseMsgPreview(source: Buffer): EmlPreviewData {
	const { reader, data } = open(source);
	const html = bodyHtml(data);
	const lower = html?.toLowerCase() ?? "";
	const recipients = data.recipients ?? [];
	const of = (type: "to" | "cc") =>
		field(
			recipients
				.filter((r) => (r.recipType ?? "to") === type)
				.map((r) => ({ name: r.name || null, address: smtp(r.smtpAddress, r.email) }))
				.filter((r) => r.name || r.address),
		);

	const cidUrls: Record<string, string> = {};
	const used = new Set<number>();
	let budget = EML_INLINE_MAX_BYTES;
	const attachments = data.attachments ?? [];
	attachments.forEach((a, index) => {
		const cid = cidOf(a);
		if (a.innerMsgContent || !cid || !lower.includes(`cid:${cid}`)) return;
		const size = a.contentLength ?? 0;
		if (size > budget) return;
		const { content } = reader.getAttachment(a);
		const declared = typeOf(a);
		const type = declared.startsWith("image/") ? declared : sniffImage(content);
		if (!type) return;
		budget -= content.length;
		cidUrls[cid] = `data:${type};base64,${Buffer.from(content).toString("base64")}`;
		used.add(index);
	});

	const sender = smtp(data.senderSmtpAddress, data.senderEmail);
	return {
		subject: data.subject ?? null,
		date: date(data),
		from: field(data.senderName || sender ? [{ name: data.senderName || null, address: sender }] : []),
		to: of("to"),
		cc: of("cc"),
		replyTo: null,
		html,
		text: data.body ?? null,
		cidUrls,
		attachments: attachments
			.map((a, index) => ({ a, index }))
			// Un mail Outlook incruste dans le .msg n'est pas un fichier extractible tel quel.
			.filter(({ a, index }) => !used.has(index) && !a.innerMsgContent)
			.map(({ a, index }) => ({
				index,
				filename: emlPartName(a.fileName || a.fileNameShort || a.name, typeOf(a), index),
				contentType: typeOf(a),
				size: a.contentLength ?? 0,
			})),
	};
}

export function msgPart(source: Buffer, index: number) {
	const { reader, data } = open(source);
	const a = data.attachments?.[index];
	if (!a || a.innerMsgContent) return null;
	const { content } = reader.getAttachment(a);
	return { filename: emlPartName(a.fileName || a.fileNameShort || a.name, typeOf(a), index), content: Buffer.from(content) };
}
