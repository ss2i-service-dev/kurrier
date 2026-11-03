import React from "react";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import BlockedSendersList from "@/components/mailbox/settings/blocked-senders-list";
import { fetchBlockedSenders } from "@/lib/actions/sender-blocks";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";

async function Page() {
    const rows = await fetchBlockedSenders();
    const nv = await isNouvelleInterface();
    const k = (en: string, fr: string) => (nv ? fr : en);
    return (
        <SectionCard
            title={k("Blocked senders", "Expéditeurs bloqués")}
            description={k(
                "Mails from these addresses and domains (subdomains included) go straight to Trash on all your identities. Block from the ... menu of an open mail.",
                "Les messages de ces adresses et domaines (sous-domaines compris) vont directement à la corbeille sur toutes vos identités. Pour bloquer un expéditeur, utilisez le menu « ... » d'un message ouvert.",
            )}
        >
            <BlockedSendersList rows={rows} />
        </SectionCard>
    );
}

export default Page;
