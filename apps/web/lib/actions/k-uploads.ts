"use server";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getServerEnv } from "@schema";
import { isSignedIn } from "@/lib/actions/auth";
import { isSafeKeySegment, safeExtension } from "@/lib/authz";

// Attachment upload URL for the modern interface, like createAttachmentUploadUrl
// (uploads-actions.ts), but with an S3 client that does not add a checksum to the signed
// URL.
//
// Why: recent versions of the AWS SDK (default checksum calculation, "WHEN_SUPPORTED")
// sign a CRC32 checksum of an EMPTY body in the URL; Garage verifies it and rejects the
// real file (400 InvalidDigest). Seen with Garage v2.3.0. The classic interface is
// unchanged; the same applies to uploads-actions.ts.
const { S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_FORCE_PATH_STYLE, S3_BUCKET } = getServerEnv();

const s3 = new S3Client({
	region: S3_REGION,
	endpoint: S3_ENDPOINT,
	forcePathStyle: S3_FORCE_PATH_STYLE === "true",
	credentials: { accessKeyId: S3_ACCESS_KEY!, secretAccessKey: S3_SECRET_KEY! },
	requestChecksumCalculation: "WHEN_REQUIRED",
	responseChecksumValidation: "WHEN_REQUIRED",
});

export async function kCreateAttachmentUploadUrl(input: { fileName: string; contentType: string; messageId: string }) {
	const user = await isSignedIn();
	if (!user) throw new Error("Unauthorized");
	// Nothing in the key may escape private/<userId>/.
	if (!isSafeKeySegment(input.messageId)) throw new Error("Invalid message id");
	const ext = safeExtension(String(input.fileName ?? ""));
	const key = `private/${user.id}/${input.messageId}/${crypto.randomUUID()}${ext ? `.${ext}` : ""}`;
	const command = new PutObjectCommand({
		Bucket: S3_BUCKET!,
		Key: key,
		ContentType: input.contentType || "application/octet-stream",
	});
	const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
	return { uploadUrl, key };
}
