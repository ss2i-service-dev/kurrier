import React from 'react';
import {Button} from "@mantine/core";
import {Trash2} from "lucide-react";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { isNouvelleInterface } from "@/lib/actions/interface-pref";

async function Page() {
    const nv = await isNouvelleInterface();
    const k = (en: string, fr: string) => (nv ? fr : en);
    return <>
        <SectionCard
            title={k("Danger zone", "Zone de danger")}
            description={k("Be careful — these actions can’t be undone.", "Attention : ces actions sont irréversibles.")}
            footer={
                <div className="flex items-center justify-end">
                    <Button color="red" leftSection={<Trash2 size={16} />}>
                        {k("Delete identity", "Supprimer l'identité")}
                    </Button>
                </div>
            }
        >
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100">
                {k("Deleting an identity will remove its mailboxes, rules, and related data.", "Supprimer une identité supprime ses dossiers, ses règles et les données associées.")}
            </div>
        </SectionCard>
    </>
}

export default Page;
