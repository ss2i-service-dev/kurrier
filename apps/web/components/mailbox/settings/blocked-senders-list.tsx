"use client";

import React, { useState } from "react";
import { Badge, Button } from "@mantine/core";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import type { BlockedSenderEntity } from "@db";
import { unblockSender } from "@/lib/actions/sender-blocks";
import { useK } from "@/components/k/ui-context";

// ss2i : liste des expediteurs bloques de l'utilisateur, avec Unblock.
export default function BlockedSendersList({ rows }: { rows: BlockedSenderEntity[] }) {
    const router = useRouter();
    const k = useK();
    const [busyId, setBusyId] = useState<string | null>(null);

    if (!rows.length) {
        return (
            <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                {k("No blocked sender.", "Aucun expéditeur bloqué.")}
            </div>
        );
    }

    const unblock = async (row: BlockedSenderEntity) => {
        setBusyId(row.id);
        const res = await unblockSender(row.id);
        setBusyId(null);
        if (res.success) {
            toast.success(k(`Unblocked ${row.value}`, `${row.value} débloqué`), { position: "bottom-left" });
            router.refresh();
        } else {
            toast.error(res.error ?? k("Unblock failed", "Le déblocage a échoué"), { position: "bottom-left" });
        }
    };

    return (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {rows.map((row) => (
                <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <Badge size="sm" variant="light" color={row.kind === "domain" ? "red" : "gray"}>
                            {row.kind === "domain" ? k("Domain", "Domaine") : k("Address", "Adresse")}
                        </Badge>
                        <span className="truncate text-sm">{row.value}</span>
                    </div>
                    <Button size="compact-xs" variant="light" loading={busyId === row.id} onClick={() => unblock(row)}>
                        {k("Unblock", "Débloquer")}
                    </Button>
                </li>
            ))}
        </ul>
    );
}
