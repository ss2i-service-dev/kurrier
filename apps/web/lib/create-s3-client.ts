import { S3Client } from "@aws-sdk/client-s3";
import { getServerEnv } from "@schema";
import { s3ClientOptions } from "@/lib/s3-options";

export const s3 = new S3Client(s3ClientOptions(getServerEnv()));
