import React from 'react';
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";

async function Page() {
    const nv = await isNouvelleInterface();
    const k = (en: string, fr: string) => (nv ? fr : en);
    return <>
        <SectionCard
            title={k("Subscriptions", "Abonnements")}
            description={k("Subscriptions detected from List-Unsubscribe headers.", "Abonnements détectés grâce aux en-têtes List-Unsubscribe.")}
        >
            <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                {k("Show a searchable list here (domain/list-id, status, last seen, unsubscribe).", "Liste consultable à venir (domaine, état, dernière réception, désinscription).")}
            </div>
        </SectionCard>
    </>
}

export default Page;
