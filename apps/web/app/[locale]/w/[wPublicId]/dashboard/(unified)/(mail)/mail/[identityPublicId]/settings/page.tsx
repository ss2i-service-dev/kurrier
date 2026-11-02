import React from "react";
import SettingsGeneral from "@/components/mailbox/settings/settings-general";
import SettingsSignature from "@/components/mailbox/settings/settings-signature";
import SettingsUnreadPanel from "@/components/mailbox/settings/settings-unread-panel";
import SettingsComposeStyle from "@/components/mailbox/settings/settings-compose-style";
import { unreadPanelEnabled } from "@/lib/actions/unread-panel";
import { listPreviewMode } from "@/lib/actions/list-preview";
import { rfcStyleEnabled } from "@/lib/actions/rfc-style";
import { FormState, handleAction } from "@schema";
import { decode } from "decode-formdata";
import { rlsClient } from "@/lib/actions/clients";
import { identities } from "@db";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";


async function Page({params}: {params: Promise<Record<string, string>>}) {

    const paramsResolved = await params;
    // ss2i : option du panneau des non-lus (par utilisateur, cote serveur).
    const unreadPanelOn = await unreadPanelEnabled();
    const listPreview = await listPreviewMode();
    // ss2i : style RFC a l'envoi (par utilisateur, cote serveur).
    const rfcStyle = await rfcStyleEnabled();
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
        <SettingsUnreadPanel enabled={unreadPanelOn} listPreview={listPreview} />
        <SettingsComposeStyle enabled={rfcStyle} />
    </>
}

export default Page;
