"use client"
import React from 'react';
import {ChevronRight, Cog} from "lucide-react";
import { ActionIcon, Button } from "@mantine/core";
import Link from "next/link";
import {useParams} from "next/navigation";

function IdentitySettingsLink({identityLabel, workspacePublicId}: {identityLabel: string, workspacePublicId: string}) {
    const params = useParams()
    // ss2i : sur mobile, la roue seule (l'adresse prenait toute la largeur et debordait de l'ecran).
    const href = `/w/${workspacePublicId}/dashboard/mail/${params.identityPublicId}/settings`;
    return <>
        <Link href={href} className={"shrink-0 md:hidden"} title={identityLabel} aria-label={`Settings ${identityLabel ?? ""}`.trim()}>
            <ActionIcon size={"lg"} radius={"xl"} variant={"light"} component={"span"}>
                <Cog size={20} />
            </ActionIcon>
        </Link>
        <Link href={href} className={"hidden shrink-0 md:block"}>
            <Button size={"sm"} className={"!rounded-full"} leftSection={<Cog size={20} />} variant={"light"} rightSection={<ChevronRight size={16} />}>
                <span className={"font-medium"}>{identityLabel}</span>
            </Button>
        </Link>
    </>
}

export default IdentitySettingsLink;
