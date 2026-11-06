import type { S3ClientConfig } from "@aws-sdk/client-s3";

// ss2i : options du client S3 du web. Sans « WHEN_REQUIRED », le SDK AWS recent signe dans les
// URL d'envoi une somme CRC32 de corps VIDE (x-amz-checksum-crc32=AAAAAA==) ; Garage la verifie
// et refuse le vrai fichier : les pieces jointes de l'interface classique ne partaient plus
// (constate en prod le 06/11/2026, test apps/web/test/compose-attachment-preview.ts).
export function s3ClientOptions(env: {
	S3_REGION?: string;
	S3_ENDPOINT?: string;
	S3_ACCESS_KEY?: string;
	S3_SECRET_KEY?: string;
	S3_FORCE_PATH_STYLE?: string;
}): S3ClientConfig {
	return {
		region: env.S3_REGION,
		endpoint: env.S3_ENDPOINT,
		forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
		credentials: {
			accessKeyId: env.S3_ACCESS_KEY!,
			secretAccessKey: env.S3_SECRET_KEY!,
		},
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	};
}
