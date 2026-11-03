"use server";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getServerEnv } from "@schema";
import { isSignedIn } from "@/lib/actions/auth";

// ss2i (nouvelle interface) : URL d'envoi d'une piece jointe, comme
// createAttachmentUploadUrl (uploads-actions.ts), mais avec un client S3 qui
// n'ajoute pas de somme de controle a l'URL signee.
//
// Pourquoi : les versions recentes du SDK AWS (calcul de checksum par defaut,
// « WHEN_SUPPORTED ») signent une somme CRC32 de corps VIDE dans l'URL ; Garage
// la verifie et refuse le vrai fichier (400 InvalidDigest). Constate en local
// (Garage v2.3.0) le 2026-11-03. L'interface classique n'est pas modifiee ;
// a signaler a l'equipe pour uploads-actions.ts.
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
	const ext = input.fileName.includes(".") ? input.fileName.split(".").pop() : "";
	const key = `private/${user.id}/${input.messageId}/${crypto.randomUUID()}${ext ? `.${ext}` : ""}`;
	const command = new PutObjectCommand({
		Bucket: S3_BUCKET!,
		Key: key,
		ContentType: input.contentType || "application/octet-stream",
	});
	const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
	return { uploadUrl, key };
}
