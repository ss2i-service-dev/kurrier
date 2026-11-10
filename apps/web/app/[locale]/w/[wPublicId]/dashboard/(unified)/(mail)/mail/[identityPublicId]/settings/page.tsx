import React from "react";
import SettingsGeneral from "@/components/mailbox/settings/settings-general";
import SettingsSignature from "@/components/mailbox/settings/settings-signature";
import SettingsUnreadPanel from "@/components/mailbox/settings/settings-unread-panel";
import SettingsComposeStyle from "@/components/mailbox/settings/settings-compose-style";
import { unreadPanelEnabled } from "@/lib/actions/unread-panel";
import { listPreviewMode } from "@/lib/actions/list-preview";
import { threadOrder } from "@/lib/actions/thread-order";
import { listUnderThread } from "@/lib/actions/list-under-thread";
import { rfcStyleEnabled } from "@/lib/actions/rfc-style";
import { stripSubjectPrefixesEnabled } from "@/lib/actions/subject-prefixes";
import { undoSendSeconds } from "@/lib/actions/undo-send";
import SettingsInterface from "@/components/mailbox/settings/settings-interface";
import { interfaceMode } from "@/lib/actions/interface-pref";
import { FormState, handleAction } from "@schema";
import { decode } from "decode-formdata";
import { rlsClient } from "@/lib/actions/clients";
import { identities } from "@db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";


async function Page({params}: {params: Promise<Record<string, string>>}) {

    const paramsResolved = await params;
    // Unread panel option (per user, stored server-side).
    const unreadPanelOn = await unreadPanelEnabled();
    const listPreview = await listPreviewMode();
    const conversationOrder = await threadOrder();
    const listUnder = await listUnderThread();
    const stripPrefixes = await stripSubjectPrefixesEnabled();
    // RFC style on send (per user, stored server-side).
    const rfcStyle = await rfcStyleEnabled();
    // Undo-send delay (per user).
    const undoSeconds = await undoSendSeconds();
    // Classic or modern interface (per user).
    const uiMode = await interfaceMode();
    const rls = await rlsClient();
    const [identity] = await rls((tx) =>
        tx
            .select()
            .from(identities)
            .where(eq(identities.publicId, paramsResolved.identityPublicId))
    );

    const updateName = async (_prev: FormState, formData: FormData): Promise<FormState> => {
        "use server";
        return handleAction(async () => {
            const decodedForm = decode(formData);
            const rls = await rlsClient();
            await rls((tx) =>
                tx
                    .update(identities)
                    .set({
                        displayName: decodedForm.displayName as string,
                    })
                    .where(eq(identities.id, decodedForm.id as string)),
            );
            revalidatePath(String(decodedForm.pathname))
            return {success: true, message: "Display name updated."};
        })
    }

    const updateSignature = async (_prev: FormState, formData: FormData): Promise<FormState> => {
        "use server";
        return handleAction(async () => {
            const decodedForm = decode(formData);
            const signatureHtml = String(decodedForm.signatureHtml ?? "").trim();
            const rls = await rlsClient();
            await rls(async (tx) => {
                const [current] = await tx
                    .select({ metaData: identities.metaData })
                    .from(identities)
                    .where(eq(identities.id, decodedForm.id as string));
                const meta = { ...((current?.metaData as Record<string, unknown>) ?? {}) };
                if (signatureHtml) meta.signatureHtml = signatureHtml;
                else delete meta.signatureHtml;
                await tx
                    .update(identities)
                    .set({ metaData: meta })
                    .where(eq(identities.id, decodedForm.id as string));
            });
            revalidatePath(String(decodedForm.pathname))
            return {success: true, message: "Signature updated."};
        })
    }

    return <>
        <SettingsGeneral updateName={updateName} identity={identity} />
        <SettingsSignature updateSignature={updateSignature} identity={identity} />
        <SettingsUnreadPanel enabled={unreadPanelOn} listPreview={listPreview} threadOrder={conversationOrder} listUnderThread={listUnder} stripPrefixes={stripPrefixes} />
        <SettingsComposeStyle enabled={rfcStyle} undoSeconds={undoSeconds} />
        <SettingsInterface mode={uiMode} />
    </>
}

export default Page;
