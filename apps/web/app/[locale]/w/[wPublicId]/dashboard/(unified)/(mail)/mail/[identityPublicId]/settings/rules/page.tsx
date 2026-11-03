import React from "react";
import { eq} from "drizzle-orm";
import { identities } from "@db";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import CreateMailRuleForm from "@/components/mailbox/settings/rules/create-rule-form";
import {createRule, fetchMailRules, getAppLabels} from "@/lib/actions/mail-rules";
import { rlsClient } from "@/lib/actions/clients";
import MailRulesList from "@/components/mailbox/settings/rules/mail-rules-list";
import { Divider } from "@mantine/core";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";

async function Page({ params }: { params: { identityPublicId: string } }) {

    const resolvedParams = await params;
    // ss2i : textes de la nouvelle interface en francais.
    const nv = await isNouvelleInterface();
    const k = (en: string, fr: string) => (nv ? fr : en);
    const rls = await rlsClient();

    const [identity] = await rls((tx) =>
        tx
            .select()
            .from(identities)
            .where(eq(identities.publicId, resolvedParams.identityPublicId)),
    );




    if (!identity) {
        return (
            <SectionCard
                title={k("Rules", "Règles")}
                description={k("Create filters to automatically process incoming mail.", "Créez des filtres pour traiter automatiquement le courrier entrant.")}
            >
                <div className="text-sm text-neutral-600 dark:text-neutral-400">
                    {k("Identity not found.", "Identité introuvable.")}
                </div>
            </SectionCard>
        );
    }

    const appLabels = await getAppLabels();
    const rules = await fetchMailRules(identity.id);

    return (
        <SectionCard
            title={k("Rules", "Règles")}
            description={k("Create filters to automatically process incoming mail.", "Créez des filtres pour traiter automatiquement le courrier entrant.")}
        >
            <MailRulesList rules={rules} />
            {rules.length > 0 && <Divider my={"xl"} variant={"dashed"} label={<span className={"text-sm"}>{k("Add New Label", "Nouvelle règle")}</span>} labelPosition={"left"} />}
            <CreateMailRuleForm identityId={identity.id} action={createRule} appLabels={appLabels} />

        </SectionCard>
    );
}

export default Page;
