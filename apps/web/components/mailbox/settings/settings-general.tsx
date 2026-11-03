"use client";
import React from 'react';
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import {IdentityEntity} from "@db";
import {ReusableForm} from "@/components/common/reusable-form";
import {FormState} from "@schema";
import {usePathname} from "next/navigation";
import { useK } from "@/components/k/ui-context";

type UpdateNameAction = (_prev: FormState, formData: FormData) => Promise<FormState>;

function SettingsGeneral({ updateName, identity }: {updateName: UpdateNameAction, identity: IdentityEntity}) {

    const pathname = usePathname()
    const k = useK()

    const fields = [
        {
            name: "displayName",
            label: k("Display Name", "Nom affiché"),
            wrapperClasses: "col-span-6",
            props: {
                defaultValue: identity.displayName,
                required: true,
            },
        },
        {
            name: "value",
            label: k("Email", "Adresse e-mail"),
            wrapperClasses: "col-span-6",
            props: {
                defaultValue: identity.value,
                readOnly: true,
                disabled: true,
            },
        },
        {
            name: "id",
            wrapperClasses: "hidden",
            props: { hidden: true, defaultValue: identity.id },
        },
        {
            name: "pathname",
            wrapperClasses: "hidden",
            props: { hidden: true, defaultValue: pathname },
        }
    ];

    return <>
        <SectionCard
            title={k("Identity details", "Informations de l'identité")}
            description={k("Basic info used across the webmail UI.", "Informations utilisées dans toute la messagerie.")}
        >

            <ReusableForm
                fields={fields}
                action={updateName}
                submitButtonProps={{
                    wrapperClasses: "flex items-center justify-end my-4 py-3",
                    submitLabel: k("Save changes", "Enregistrer"),
                }}
            />

        </SectionCard>

    </>
}

export default SettingsGeneral;
