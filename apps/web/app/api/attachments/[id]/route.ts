// ss2i : ouverture d'une piece jointe de message, signee au moment du clic (voir
// lib/attachment-links.ts). L'acces passe par RLS, comme l'affichage du fil.
// - open / download : redirection vers une URL S3 fraiche. Le fichier reste servi par
//   l'origine S3 : une piece jointe HTML ou SVG ne s'execute jamais sur celle de l'application.
// - listing : liste JSON des fichiers d'un zip, lue par plages S3 (lib/zip-listing.ts).
// - message : mail joint (.eml) decode en JSON pour la visionneuse ; part (&part=N) : une de ses
//   pieces jointes, en telechargement (lib/eml-preview.ts, lib/eml-parse.ts).
// - content : octets d'un pptx, d'un texte, d'un CSV ou d'un classeur pour l'apercu, sur la meme origine (S3 refuse le fetch du
//   navigateur, CORS). Jamais interpretables : type binaire, attachment, nosniff, sandbox.
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { messageAttachments } from "@db";
import { getServerEnv } from "@schema";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { rlsClient } from "@/lib/actions/clients";
import {
	canPreviewPptx,
	isAttachmentId,
	parseAttachmentMode,
	PPTX_PREVIEW_MAX_BYTES,
} from "@/lib/attachment-links";
import { canPreviewSheet, SHEET_PREVIEW_MAX_BYTES } from "@/lib/sheet-preview";
import { canPreviewText, TEXT_PREVIEW_MAX_BYTES } from "@/lib/text-preview";
import {
	canListZip,
	locateCentralDirectory,
	parseCentralDirectory,
	ZIP_DIRECTORY_MAX_BYTES,
	ZIP_TAIL_BYTES,
} from "@/lib/zip-listing";
import { attachmentDisposition } from "@/lib/compose-attachment-preview";
import { canPreviewEml, EML_PREVIEW_MAX_BYTES, parsePartIndex } from "@/lib/eml-preview";
import { emlPart, parseEmlPreview } from "@/lib/eml-parse";
import { s3 } from "@/lib/create-s3-client";

export const dynamic = "force-dynamic";

// Assez long pour lire une video ou un gros PDF, qui rechargent par plages apres le clic.
const SIGNED_URL_SECONDS = 15 * 60;

const failure = (status: number, message: string) =>
	new Response(message, {
		status,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const mode = parseAttachmentMode(req.nextUrl.searchParams.get("mode"));
	if (!mode || !isAttachmentId(id)) return failure(404, "Pièce jointe introuvable.");

	let rls: Awaited<ReturnType<typeof rlsClient>>;
	try {
		rls = await rlsClient();
	} catch {
		return failure(401, "Session expirée : reconnectez-vous à Courrier puis rouvrez la pièce jointe.");
	}
	const [attachment] = await rls((tx) =>
		tx.select().from(messageAttachments).where(eq(messageAttachments.id, id)).limit(1),
	);
	if (!attachment?.path) return failure(404, "Pièce jointe introuvable.");

	const { S3_BUCKET } = getServerEnv();
	const Bucket = S3_BUCKET!;
	const Key = attachment.path;

	if (mode === "message" || mode === "part") {
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "private, no-store",
				},
			});
		if (!canPreviewEml(attachment)) return failure(415, "Aperçu indisponible pour ce fichier.");
		const part = mode === "part" ? parsePartIndex(req.nextUrl.searchParams.get("part")) : null;
		if (mode === "part" && part === null) return failure(404, "Pièce jointe introuvable.");
		const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
		if (!object.Body) return failure(404, "Pièce jointe introuvable.");
		if (Number(object.ContentLength ?? 0) > EML_PREVIEW_MAX_BYTES) {
			object.Body.transformToWebStream().cancel().catch(() => {});
			return mode === "message"
				? json({ error: "Mail trop volumineux pour l'aperçu." }, 413)
				: failure(413, "Mail trop volumineux : téléchargez-le pour ouvrir ses pièces jointes.");
		}
		const source = Buffer.from(await object.Body.transformToByteArray());
		try {
			if (mode === "message") return json(await parseEmlPreview(source));
			const found = await emlPart(source, part!);
			if (!found) return failure(404, "Pièce jointe introuvable.");
			// Toujours en telechargement, jamais interpretee sur l'origine de l'application.
			return new Response(new Uint8Array(found.content), {
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Length": String(found.content.length),
					"Content-Disposition": attachmentDisposition(found.filename),
					"Content-Security-Policy": "default-src 'none'; sandbox",
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "private, no-store",
				},
			});
		} catch (error) {
			console.warn("[courrier] mail joint illisible", attachment.id, error);
			return mode === "message"
				? json({ error: "Ce mail n'a pas pu être lu." }, 422)
				: failure(422, "Ce mail n'a pas pu être lu.");
		}
	}

	if (mode === "content") {
		const maxBytes = canPreviewPptx(attachment)
			? PPTX_PREVIEW_MAX_BYTES
			: canPreviewText(attachment)
				? TEXT_PREVIEW_MAX_BYTES
				: canPreviewSheet(attachment)
					? SHEET_PREVIEW_MAX_BYTES
					: 0;
		if (!maxBytes) return failure(415, "Aperçu indisponible pour ce fichier.");
		const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
		if (!object.Body) return failure(404, "Pièce jointe introuvable.");
		if (Number(object.ContentLength ?? 0) > maxBytes) {
			object.Body.transformToWebStream().cancel().catch(() => {});
			return failure(413, "Fichier trop volumineux pour l'aperçu.");
		}
		return new Response(object.Body.transformToWebStream(), {
			headers: {
				"Content-Type": "application/octet-stream",
				...(object.ContentLength ? { "Content-Length": String(object.ContentLength) } : {}),
				"Content-Disposition": attachmentDisposition(attachment.filenameOriginal),
				"Content-Security-Policy": "default-src 'none'; sandbox",
				"X-Content-Type-Options": "nosniff",
				"Cache-Control": "private, no-store",
			},
		});
	}

	if (mode === "listing") {
		if (!canListZip(attachment)) return failure(415, "Aperçu indisponible pour ce fichier.");
		const read = async (Range: string) => {
			const object = await s3.send(new GetObjectCommand({ Bucket, Key, Range }));
			const bytes = object.Body ? await object.Body.transformToByteArray() : new Uint8Array();
			// Content-Range : « bytes debut-fin/total »
			const total = Number(String(object.ContentRange ?? "").split("/")[1] ?? bytes.length);
			return { bytes, total: Number.isFinite(total) && total > 0 ? total : bytes.length };
		};
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"X-Content-Type-Options": "nosniff",
					"Cache-Control": "private, no-store",
				},
			});
		try {
			const tail = await read(`bytes=-${ZIP_TAIL_BYTES}`);
			const dir = locateCentralDirectory(tail.bytes, tail.total);
			if (!dir) return json({ error: "Ce fichier n'est pas un zip lisible." }, 422);
			if (dir.size > ZIP_DIRECTORY_MAX_BYTES) return json({ error: "Archive trop volumineuse pour l'aperçu." }, 413);
			const tailStart = tail.total - tail.bytes.length;
			// Le repertoire central est souvent deja dans les derniers octets lus.
			const directory =
				dir.offset >= tailStart
					? tail.bytes.subarray(dir.offset - tailStart, dir.offset - tailStart + dir.size)
					: dir.size === 0
						? new Uint8Array()
						: (await read(`bytes=${dir.offset}-${dir.offset + dir.size - 1}`)).bytes;
			const listing = parseCentralDirectory(directory);
			return json({ ...listing, archiveSize: tail.total });
		} catch (error) {
			console.warn("[courrier] liste du zip impossible", attachment.id, error);
			return json({ error: "La liste des fichiers n'a pas pu être lue." }, 502);
		}
	}

	const url = await getSignedUrl(
		s3,
		new GetObjectCommand({
			Bucket,
			Key,
			...(mode === "download"
				? { ResponseContentDisposition: attachmentDisposition(attachment.filenameOriginal) }
				: {}),
		}),
		{ expiresIn: SIGNED_URL_SECONDS },
	);
	return new Response(null, {
		status: 302,
		headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
	});
}
