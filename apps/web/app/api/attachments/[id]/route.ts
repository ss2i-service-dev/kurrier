// ss2i : ouverture d'une piece jointe de message, signee au moment du clic (voir
// lib/attachment-links.ts). L'acces passe par RLS, comme l'affichage du fil.
// - open / download : redirection vers une URL S3 fraiche. Le fichier reste servi par
//   l'origine S3 : une piece jointe HTML ou SVG ne s'execute jamais sur celle de l'application.
// - content : octets d'un pptx pour l'apercu, sur la meme origine (S3 refuse le fetch du
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
import { attachmentDisposition } from "@/lib/compose-attachment-preview";
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

	if (mode === "content") {
		if (!canPreviewPptx(attachment)) return failure(415, "Aperçu indisponible pour ce fichier.");
		const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
		if (!object.Body) return failure(404, "Pièce jointe introuvable.");
		if (Number(object.ContentLength ?? 0) > PPTX_PREVIEW_MAX_BYTES) {
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
