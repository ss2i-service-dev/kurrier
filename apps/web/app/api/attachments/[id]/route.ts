// Opening of a message attachment, signed at click time (see lib/attachment-links.ts).
// Access goes through RLS, like the display of the thread. The response is a redirect to a
// fresh S3 URL: the file stays served by the S3 origin, so an HTML or SVG attachment never
// runs on the origin of the application.
// - content: the bytes of a .pptx for the preview, on the same origin (S3 refuses the fetch
//   of the browser, CORS). Never interpretable: binary type, attachment, nosniff, sandbox.
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { messageAttachments } from "@db";
import { getServerEnv } from "@schema";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { rlsClient } from "@/lib/actions/clients";
import {
	attachmentDisposition,
	canPreviewPptx,
	isAttachmentId,
	parseAttachmentMode,
	PPTX_PREVIEW_MAX_BYTES,
} from "@/lib/attachment-links";
import { s3 } from "@/lib/create-s3-client";

export const dynamic = "force-dynamic";

// Long enough to read a video or a big PDF, which reload by ranges after the click.
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
	if (!mode || !isAttachmentId(id)) return failure(404, "Attachment not found.");

	let rls: Awaited<ReturnType<typeof rlsClient>>;
	try {
		rls = await rlsClient();
	} catch {
		return failure(401, "Session expired: sign in again, then reopen the attachment.");
	}
	const [attachment] = await rls((tx) =>
		tx.select().from(messageAttachments).where(eq(messageAttachments.id, id)).limit(1),
	);
	if (!attachment?.path) return failure(404, "Attachment not found.");

	const { S3_BUCKET } = getServerEnv();
	const Bucket = S3_BUCKET!;
	const Key = attachment.path;

	if (mode === "content") {
		if (!canPreviewPptx(attachment)) return failure(415, "Preview not available for this file.");
		const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
		if (!object.Body) return failure(404, "Attachment not found.");
		if (Number(object.ContentLength ?? 0) > PPTX_PREVIEW_MAX_BYTES) {
			object.Body.transformToWebStream().cancel().catch(() => {});
			return failure(413, "File too large for the preview.");
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
