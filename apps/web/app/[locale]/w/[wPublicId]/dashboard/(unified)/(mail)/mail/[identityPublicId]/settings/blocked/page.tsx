import React from "react";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import BlockedSendersList from "@/components/mailbox/settings/blocked-senders-list";
import { fetchBlockedSenders } from "@/lib/actions/sender-blocks";

async function Page() {
    const rows = await fetchBlockedSenders();
    return (
        <SectionCard
            title={"Blocked senders"}
            description={"Mails from these addresses and domains (subdomains included) go straight to Trash on all your identities. Block from the ... menu of an open mail."}
        >
            <BlockedSendersList rows={rows} />
        </SectionCard>
    );
}

export default Page;
