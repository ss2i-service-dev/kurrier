"use client";

import React, { useState } from "react";
import { Checkbox, NumberInput, Select, Switch } from "@mantine/core";
import { ReusableForm } from "@/components/common/reusable-form";
import type { BaseFormProps } from "@schema";
import { ReusableFormItems } from "@/components/common/reusable-form-items";
import { LabelEntity } from "@db";
import {FetchAppLabelsResult} from "@/lib/actions/mail-rules";
import { useK } from "@/components/k/ui-context";

type BoolSwitchProps = {
    name: string;
    defaultChecked?: boolean;
    size?: any;
    label?: React.ReactNode;
    onChange?: (e: any) => void;
};

function BoolSwitch(props: BoolSwitchProps) {
    const { name, defaultChecked = false, onChange, ...rest } = props;
    const [checked, setChecked] = useState<boolean>(defaultChecked);

    return (
        <>
            <input
                type="hidden"
                name={name}
                value={checked ? "true" : "false"}
                readOnly
            />
            <Switch
                checked={checked}
                onChange={(e) => {
                    setChecked(e.currentTarget.checked);
                    onChange?.(e);
                }}
                {...rest}
            />
        </>
    );
}

type BoolCheckboxProps = {
    name: string;
    defaultChecked?: boolean;
    label?: React.ReactNode;
    onChange?: (e: any) => void;
};

function BoolCheckbox(props: BoolCheckboxProps) {
    const { name, defaultChecked = false, onChange, label } = props;
    const [checked, setChecked] = useState<boolean>(defaultChecked);

    return (
        <>
            <input
                type="hidden"
                name={name}
                value={checked ? "true" : "false"}
                readOnly
            />
            <Checkbox
                checked={checked}
                size={"xs"}
                onChange={(e) => {
                    setChecked(e.currentTarget.checked);
                    onChange?.(e);
                }}
                label={label}
            />
        </>
    );
}

type BoolCheckboxControlledProps = {
    name: string;
    checked: boolean;
    onChange: (e: any) => void;
    label?: React.ReactNode;
};

function BoolCheckboxControlled({
                                    name,
                                    checked,
                                    onChange,
                                    label,
                                }: BoolCheckboxControlledProps) {
    return (
        <>
            <input
                type="hidden"
                name={name}
                value={checked ? "true" : "false"}
                readOnly
            />
            <Checkbox size={"xs"} checked={checked} onChange={onChange} label={label} />
        </>
    );
}

// ss2i : libelles traduits via useK dans le composant (voir sizeOpOptions).
const SIZE_OP_VALUES = ["gt", "lt"] as const;

const SIZE_UNIT_OPTIONS = [
    { value: "KB", label: "KB" },
    { value: "MB", label: "MB" },
] as const;

export default function CreateRuleFormGmailV1({ action, identityId, appLabels, initialName}: { action: any; identityId: string; appLabels: FetchAppLabelsResult, initialName?: string; }) {
    const k = useK();
    initialName = initialName ?? k("New rule", "Nouvelle règle");
    const [applyLabel, setApplyLabel] = useState(false);
    const SIZE_OP_OPTIONS = [
        { value: SIZE_OP_VALUES[0], label: k("greater than", "supérieure à") },
        { value: SIZE_OP_VALUES[1], label: k("less than", "inférieure à") },
    ];

    const criteriaFields: BaseFormProps["fields"] = [
        {
            name: "from",
            label: k("From", "De"),
            wrapperClasses: "col-span-12 md:col-span-6",
            props: {
                defaultValue: "",
                placeholder: k("e.g. newsletter@company.com", "ex. newsletter@societe.fr"),
                autoComplete: "off",
            },
        },
        {
            name: "to",
            label: k("To", "À"),
            wrapperClasses: "col-span-12 md:col-span-6",
            props: {
                defaultValue: "",
                placeholder: k("e.g. me@domain.com", "ex. moi@domaine.fr"),
                autoComplete: "off",
            },
        },
        {
            name: "subject",
            label: k("Subject", "Objet"),
            wrapperClasses: "col-span-12 md:col-span-6",
            props: {
                defaultValue: "",
                placeholder: k("e.g. invoice", "ex. facture"),
                autoComplete: "off",
            },
        },
        {
            name: "hasWords",
            label: k("Has the words", "Contient les mots"),
            wrapperClasses: "col-span-12 md:col-span-6",
            props: {
                defaultValue: "",
                placeholder: k("e.g. unsubscribe", "ex. désinscription"),
                autoComplete: "off",
            },
        },
        {
            name: "doesntHave",
            label: k("Doesn't have", "Ne contient pas"),
            wrapperClasses: "col-span-12 md:col-span-6",
            props: {
                defaultValue: "",
                placeholder: k("e.g. urgent", "ex. urgent"),
                autoComplete: "off",
            },
        },
        {
            name: "hasAttachment",
            kind: "custom",
            component: BoolCheckbox,
            wrapperClasses:
                "col-span-12 md:col-span-6 flex items-center gap-2 justify-end-safe flex-row flex-row-reverse mt-3",
            props: {
                defaultChecked: false,
                label: <div className="text-sm -mt-1">{k("Has attachment", "Avec pièce jointe")}</div>,
            },
        },
    ];

    const sizeFields: BaseFormProps["fields"] = [
        {
            name: "sizeOp",
            label: k("Operator", "Opérateur"),
            kind: "select",
            wrapperClasses: "col-span-12 md:col-span-4",
            options: SIZE_OP_OPTIONS as any,
            props: {
                defaultValue: "gt",
            },
        },
        {
            name: "sizeValue",
            label: k("Value", "Valeur"),
            kind: "custom",
            component: NumberInput,
            wrapperClasses: "col-span-12 md:col-span-4",
            props: {
                defaultValue: 0,
                min: 0,
                step: 1,
            },
        },
        {
            name: "sizeUnit",
            label: k("Unit", "Unité"),
            kind: "select",
            wrapperClasses: "col-span-12 md:col-span-4",
            options: SIZE_UNIT_OPTIONS as any,
            props: {
                defaultValue: "MB",
            },
        },
    ];

    const actionFields: BaseFormProps["fields"] = [
        {
            name: "markRead",
            label: k("Mark as read", "Marquer comme lu"),
            kind: "custom",
            component: BoolCheckbox,
            wrapperClasses:
                "col-span-12 md:col-span-6 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2",
            props: {
                defaultChecked: false,
                label: <div className="text-sm">{k("Mark as read", "Marquer comme lu")}</div>,
            },
        },
        {
            name: "flag",
            label: k("Star it (Flag)", "Ajouter une étoile"),
            kind: "custom",
            component: BoolCheckbox,
            wrapperClasses:
                "col-span-12 md:col-span-6 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2",
            props: {
                defaultChecked: false,
                label: <div className="text-sm">{k("Star it (Flag)", "Ajouter une étoile")}</div>,
            },
        },
        {
            name: "trash",
            label: k("Delete it (Trash)", "Mettre à la corbeille"),
            kind: "custom",
            component: BoolCheckbox,
            wrapperClasses:
                "col-span-12 md:col-span-6 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-2",
            props: {
                defaultChecked: false,
                label: <div className="text-sm">{k("Delete it (Trash)", "Mettre à la corbeille")}</div>,
            },
        },
        {
            name: "applyLabel",
            label: k("Apply label", "Appliquer un libellé"),
            kind: "custom",
            component: BoolCheckboxControlled,
            wrapperClasses:
                "col-span-6 rounded-lg border border-neutral-200 dark:border-neutral-800 p-3",
            props: {
                checked: applyLabel,
                onChange: (e: any) => setApplyLabel(e.currentTarget.checked),
                label: <div className="text-sm">{k("Apply label", "Appliquer un libellé")}</div>,
            },
        },
        ...(applyLabel
            ? ([
                {
                    name: "labelId",
                    label: k("Label Name", "Libellé"),
                    kind: "custom",
                    component: Select,
                    wrapperClasses: "col-span-12",
                    props: {
                        data: appLabels.map((label) => ({
                            value: label.id,
                            label: label.name,
                        })),
                        allowDeselect: false,
                        defaultValue: appLabels[0]?.id || "",
                        required: true,
                    },
                }
            ] as BaseFormProps["fields"])
            : [
                {
                    name: "labelId",
                    wrapperClasses: "hidden",
                    props: { type: "hidden", value: "", readOnly: true },
                },
            ]),
    ];

    const fields: BaseFormProps["fields"] = [
        {
            name: "identityId",
            wrapperClasses: "hidden",
            props: { type: "hidden", value: identityId, readOnly: true },
        },
        {
            name: "name",
            label: k("Rule name", "Nom de la règle"),
            wrapperClasses: "col-span-12 md:col-span-7",
            props: {
                required: true,
                placeholder: k("e.g. Newsletters", "ex. Newsletters"),
                defaultValue: initialName,
                autoComplete: "off",
            },
        },
        {
            name: "priority",
            label: k("Priority", "Priorité"),
            kind: "custom",
            component: NumberInput,
            wrapperClasses: "col-span-12 md:col-span-3",
            props: {
                defaultValue: 100,
                min: 0,
                step: 10,
            },
        },
        {
            name: "enabled",
            label: k("Enabled", "Activée"),
            kind: "custom",
            component: BoolSwitch,
            wrapperClasses: "col-span-12 md:col-span-2 flex items-end justify-end gap-2 flex-col",
            props: {
                defaultChecked: true,
                size: "sm",
            },
        },
        {
            el: (
                <div className="col-span-12 mt-2 rounded-xl border border-neutral-200 dark:border-neutral-800 p-4">
                    <div className="text-sm font-semibold">{k("Criteria", "Critères")}</div>
                    <div className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                        {k("Messages must match all filled fields.", "Les messages doivent correspondre à tous les champs renseignés.")}
                    </div>

                    <ReusableFormItems
                        formWrapperClasses="mt-4 grid grid-cols-12 gap-3"
                        fields={criteriaFields}
                    />

                    <div className="mt-3 rounded-lg border border-neutral-200 dark:border-neutral-800 p-3">
                        <div className="text-sm font-medium">{k("Size", "Taille")}</div>
                        <ReusableFormItems
                            formWrapperClasses="mt-3 grid grid-cols-12 gap-3"
                            fields={sizeFields}
                        />
                    </div>
                </div>
            ),
        },
        {
            el: (
                <div className="col-span-12 rounded-xl border border-neutral-200 dark:border-neutral-800 p-4">
                    <div className="text-sm font-semibold">{k("Actions", "Actions")}</div>
                    <div className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                        {k("What to do when a message matches.", "Ce qu'il faut faire quand un message correspond.")}
                    </div>

                    <ReusableFormItems
                        formWrapperClasses="mt-4 grid grid-cols-12 gap-3"
                        fields={actionFields}
                    />
                </div>
            ),
        },
    ];

    return (
        <ReusableForm
            action={action}
            fields={fields}
            submitButtonProps={{
                submitLabel: k("Create rule", "Créer la règle"),
                wrapperClasses: "mt-4 flex justify-start py-4",
                fullWidth: false,
            }}
            formWrapperClasses="grid grid-cols-12 gap-4"
        />
    );
}
