"use server"


import {isSignedIn} from "@/lib/actions/auth";
import {getServerEnv} from "@schema";
import {GetObjectCommand, PutObjectCommand} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import {s3} from "@/lib/create-s3-client";
import {messages} from "@db";
import {eq} from "drizzle-orm";
import {rlsClient} from "@/lib/actions/clients";
import {assertOwnedS3Key, assertSignedIn, isSafeKeySegment, safeExtension} from "@/lib/authz";

export async function createAttachmentUploadUrl(input: {
    fileName: string;
    contentType: string;
    messageId: string;
}) {
    const user = await isSignedIn();
    if (!user) throw new Error("Unauthorized");
    if (!isSafeKeySegment(input.messageId)) throw new Error("Invalid message id");
    const { S3_BUCKET } = getServerEnv();

    const ext = safeExtension(String(input.fileName ?? ""));

    const key = `private/${user.id}/${input.messageId}/${crypto.randomUUID()}${
        ext ? `.${ext}` : ""
    }`;

    const command = new PutObjectCommand({
        Bucket: S3_BUCKET!,
        Key: key,
        ContentType: input.contentType || "application/octet-stream",
    });

    const uploadUrl = await getSignedUrl(s3, command, {
        expiresIn: 300,
    });

    return {
        uploadUrl,
        key,
    };
}


export async function createAttachmentDownloadUrl(path: string) {
    const user = await isSignedIn();
    if (!user) throw new Error("Unauthorized");
    // Only an attachment of the user or of a message of their workspace; used to accept any
    // key of the bucket.
    const key = await assertOwnedS3Key(path, user.id);
    const { S3_BUCKET } = getServerEnv();
    const command = new GetObjectCommand({
        Bucket: S3_BUCKET!,
        Key: key,
    });

    const url = await getSignedUrl(s3, command, {
        expiresIn: 300,
    });

    return { url };
}

export async function getRawMessageDownloadUrl(messageId: string) {
    const rls = await rlsClient();
    const [message] = await rls((tx) =>
        tx
            .select()
            .from(messages)
            .where(eq(messages.id, messageId))
            .limit(1),
    );
    if (!message?.rawStorageKey) {
        return { url: null };
    }
    const { S3_BUCKET } = getServerEnv();
    const command = new GetObjectCommand({
        Bucket: S3_BUCKET!,
        Key: message.rawStorageKey,
    });
    const url = await getSignedUrl(s3, command, {
        expiresIn: 300,
    });
    return { url };
}



export async function uploadContactProfileAction(params: {
    mainFile: File;
    thumbFile: File;
    mainPath: string;
    thumbPath: string;
}) {
    const { mainFile, thumbFile, mainPath, thumbPath } = params;

    // Signed-in user, images only, and keys under their own contacts folder (same shape as
    // the contact forms and the DAV sync: private/<userId>/contacts/<publicId>/<name>.<ext>);
    // used to allow writing to any key of the bucket, without sign-in.
    const user = await assertSignedIn();
    const contactKey = new RegExp(
        `^private/${user.id}/contacts/[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}\\.[A-Za-z0-9]{1,12}$`,
    );
    if (!contactKey.test(String(mainPath)) || !contactKey.test(String(thumbPath))) {
        throw new Error("Invalid contact image path");
    }
    if (!String(mainFile?.type).startsWith("image/") || !String(thumbFile?.type).startsWith("image/")) {
        throw new Error("Contact image must be an image");
    }

    const mainBuffer = Buffer.from(await mainFile.arrayBuffer());
    const thumbBuffer = Buffer.from(await thumbFile.arrayBuffer());

    await Promise.all([
        s3.send(
            new PutObjectCommand({
                Bucket: process.env.S3_BUCKET!,
                Key: mainPath,
                Body: mainBuffer,
                ContentType: mainFile.type,
            })
        ),
        s3.send(
            new PutObjectCommand({
                Bucket: process.env.S3_BUCKET!,
                Key: thumbPath,
                Body: thumbBuffer,
                ContentType: thumbFile.type,
            })
        ),
    ]);

    return { success: true };
}
