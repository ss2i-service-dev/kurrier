"use client";

import React, { useState } from "react";
import { Badge, Button } from "@mantine/core";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { CLEANUP_PRESETS } from "@common/cleanup-rules";
import { deleteCleanupRule, setCleanupRulePaused, type CleanupRuleItem } from "@/lib/actions/cleanup-rules";

// ss2i : regles de nettoyage automatique de l'identite (docs/plans/nettoyage-auto-recherche.md, MT9). Une
// ligne par regle : ce qui est cherche, ou, les filtres, la duree, ce qui est deja parti ; Suspendre ou
// Reprendre et Supprimer (avec confirmation), l'etat de l'action en cours reste visible sur la ligne.
// Memes libelles dans les deux interfaces : la page est en francais.
const dateFr = (d: Date | string) =>
    new Date(d).toLocaleString("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// 7 jours -> « 1 semaine », une duree libre -> « 45 jours ».
const durationLabel = (days: number) =>
    CLEANUP_PRESETS.find((p) => p.days === days)?.label ?? `${days} jour${days > 1 ? "s" : ""}`;

export default function CleanupRulesList({ rows }: { rows: CleanupRuleItem[] }) {
    const router = useRouter();
    const [busy, setBusy] = useState<{ id: string; action: "pause" | "delete" } | null>(null);

    if (!rows.length) {
        return (
            <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                Aucune règle de nettoyage. Les règles se créent depuis une recherche : lancez-la, puis choisissez « Nettoyage auto... ».
            </div>
        );
    }

    const togglePause = async (row: CleanupRuleItem) => {
        setBusy({ id: row.id, action: "pause" });
        const res = await setCleanupRulePaused(row.id, !row.paused);
        setBusy(null);
        if (res.success) {
            toast.success(row.paused ? "Règle reprise" : "Règle suspendue", { position: "bottom-left" });
            router.refresh();
        } else {
            toast.error(res.error ?? "Le changement a échoué", { position: "bottom-left" });
        }
    };

    const remove = async (row: CleanupRuleItem) => {
        if (!window.confirm(`Supprimer la règle « ${row.query} » ? Les fils déjà envoyés à la Corbeille y restent.`)) return;
        setBusy({ id: row.id, action: "delete" });
        const res = await deleteCleanupRule(row.id);
        setBusy(null);
        if (res.success) {
            toast.success("Règle supprimée", { position: "bottom-left" });
            router.refresh();
        } else {
            toast.error(res.error ?? "La suppression a échoué", { position: "bottom-left" });
        }
    };

    return (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {rows.map((row) => {
                const mine = busy?.id === row.id;
                return (
                    <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                        <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                                <span className="break-all text-sm font-medium">{row.query}</span>
                                {row.paused && (
                                    <Badge size="sm" variant="light" color="yellow">
                                        Suspendue
                                    </Badge>
                                )}
                            </div>
                            <p className="text-[13px] text-neutral-600 dark:text-neutral-400">
                                {[
                                    row.allFolders ? "Tous les dossiers" : `Dossier ${row.mailboxName}`,
                                    row.onlyUnread ? "non lus seulement" : null,
                                    row.hasAttachment ? "avec pièce jointe" : null,
                                    `au-delà de ${durationLabel(row.retentionDays)} sans nouveau message`,
                                ]
                                    .filter(Boolean)
                                    .join(", ")}
                            </p>
                            <p className="text-[13px] text-neutral-500 dark:text-neutral-500">
                                {row.trashedCount === 0
                                    ? "Aucun fil nettoyé pour l'instant."
                                    : `${row.trashedCount} fil${row.trashedCount > 1 ? "s" : ""} nettoyé${row.trashedCount > 1 ? "s" : ""}${row.lastTrashedAt ? `, dernier le ${dateFr(row.lastTrashedAt)}` : ""}.`}
                            </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            <Button
                                size="compact-xs"
                                variant="light"
                                loading={mine && busy?.action === "pause"}
                                disabled={mine && busy?.action !== "pause"}
                                onClick={() => togglePause(row)}
                            >
                                {row.paused ? "Reprendre" : "Suspendre"}
                            </Button>
                            <Button
                                size="compact-xs"
                                variant="light"
                                color="red"
                                loading={mine && busy?.action === "delete"}
                                disabled={mine && busy?.action !== "delete"}
                                onClick={() => remove(row)}
                            >
                                Supprimer
                            </Button>
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}
