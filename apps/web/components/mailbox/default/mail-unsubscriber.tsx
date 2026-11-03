"use client";

import React, { useState } from "react";
import type { MailSubscriptionEntity, MessageEntity } from "@db";
import { Badge, Button } from "@mantine/core";
import { ExternalLink, MailX } from "lucide-react";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import { chooseUnsubscribeMethod } from "@common/list-unsubscribe";
import { confirmUnsubscribed, unsubscribeFromMail } from "@/lib/actions/unsubscribe";
import BlockSenderModal from "@/components/mailbox/default/block-sender-modal";
import { useK, useNouvelle } from "@/components/k/ui-context";

// ss2i : desinscription en un clic (cf. lib/actions/unsubscribe.ts). Le bouton est mis en
// avant dans l'en-tete du mail ; le resultat est toujours visible (toast, puis badge).
type BlockTarget = { kind: "address" | "domain"; value: string };

function UnsubscribeControl({ mailSubscription, message, onBlock }: {
    message: MessageEntity;
    mailSubscription: MailSubscriptionEntity | null;
    onBlock: (t: BlockTarget) => void;
}) {
    const k = useK();
    const pathname = usePathname();
    const [busy, setBusy] = useState(false);
    // Etat local : la page n'est pas forcement rechargee apres l'action.
    const [local, setLocal] = useState<"unsubscribed" | "pending" | null>(null);
    if (!mailSubscription) return null;

    const status = local ?? (mailSubscription.status === "unsubscribed" || mailSubscription.status === "pending"
        ? mailSubscription.status
        : null);
    const method = chooseUnsubscribeMethod(mailSubscription);

    if (status === "unsubscribed") {
        return (
            <Badge size="sm" color="gray" variant="light" className="mt-0.5">
                {k("Unsubscribed", "Désinscrit")}
            </Badge>
        );
    }

    const markDone = async () => {
        const res = await confirmUnsubscribed({ mailSubscriptionId: mailSubscription.id, pathname });
        if (res.success) {
            setLocal("unsubscribed");
            toast.success(k("Unsubscribed", "Désinscription effectuée"), { position: "bottom-left" });
        } else {
            toast.error(res.error ?? k("Update failed", "Échec de la mise à jour"), { position: "bottom-left" });
        }
    };

    if (status === "pending") {
        return (
            <div className="flex items-center gap-2">
                <Badge size="sm" color="yellow" variant="light">
                    {k("Finish on the sender's page", "À terminer sur la page de l'expéditeur")}
                </Badge>
                {mailSubscription.unsubscribeHttpUrl && (
                    <Button
                        component="a"
                        href={mailSubscription.unsubscribeHttpUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        size="compact-xs"
                        variant="subtle"
                        rightSection={<ExternalLink size={12} />}
                    >
                        {k("Reopen", "Rouvrir")}
                    </Button>
                )}
                <Button size="compact-xs" variant="light" onClick={markDone}>
                    {k("Done", "Terminé")}
                </Button>
            </div>
        );
    }

    if (method === "none") {
        return (
            <Badge size="sm" color="gray" variant="light">
                {k("No unsubscribe link", "Pas de lien de désinscription")}
            </Badge>
        );
    }

    const run = async () => {
        setBusy(true);
        // La page du lien web est ouverte tout de suite, dans le geste du clic (sinon le
        // navigateur bloque la fenetre) ; le serveur marque l'abonnement « pending ».
        const win = method === "web" ? window.open("about:blank", "_blank") : null;
        try {
            const res = await unsubscribeFromMail({
                mailSubscriptionId: mailSubscription.id,
                messageId: message.id,
                pathname,
            });
            if (!res.success || !res.data) {
                win?.close();
                toast.error(res.error ?? k("Unsubscribe failed", "Échec de la désinscription"), { position: "bottom-left", duration: 8000 });
                return;
            }
            const { status: st, domain, openUrl, block } = res.data;
            if (st === "pending") {
                if (win && openUrl) win.location.href = openUrl;
                else if (openUrl) window.open(openUrl, "_blank");
                setLocal("pending");
                toast.message(k("Finish on the sender's page", "À terminer sur la page de l'expéditeur"), {
                    position: "bottom-left",
                    description: k(
                        "Complete the unsubscribe on the page that just opened, then press Done.",
                        "Terminez la désinscription sur la page qui vient de s'ouvrir, puis appuyez sur Terminé.",
                    ),
                    duration: 10000,
                });
                return;
            }
            setLocal("unsubscribed");
            const target = block.domain
                ? { kind: "domain" as const, value: block.domain }
                : { kind: "address" as const, value: block.address };
            toast.success(k(`Unsubscribed from ${domain || target.value}`, `Désinscription de ${domain || target.value}`), {
                position: "bottom-left",
                duration: 12000,
                action: target.value
                    ? { label: k(`Also block ${target.value}`, `Bloquer aussi ${target.value}`), onClick: () => onBlock(target) }
                    : undefined,
            });
        } catch (e: any) {
            win?.close();
            toast.error(e?.message ?? k("Unsubscribe failed", "Échec de la désinscription"), { position: "bottom-left", duration: 8000 });
        } finally {
            setBusy(false);
        }
    };

    return (
        <Button
            size="compact-sm"
            variant="filled"
            color="orange"
            leftSection={<MailX size={14} />}
            loading={busy}
            onClick={run}
            title={
                method === "one-click"
                    ? k("Unsubscribe automatically", "Se désinscrire automatiquement")
                    : method === "mailto"
                      ? k("Send the unsubscribe mail automatically", "Envoyer automatiquement le message de désinscription")
                      : k("Open the sender's unsubscribe page", "Ouvrir la page de désinscription de l'expéditeur")
            }
        >
            {k("Unsubscribe", "Se désinscrire")}
        </Button>
    );
}

// Le modal de blocage vit hors du controle : celui-ci devient un badge apres la desinscription.
function MailUnsubscriber(props: {
    message: MessageEntity;
    mailSubscription: MailSubscriptionEntity | null;
}) {
    const [blockTarget, setBlockTarget] = useState<BlockTarget | null>(null);
    return (
        <>
            <UnsubscribeControl {...props} onBlock={setBlockTarget} />
            {blockTarget && (
                <BlockSenderModal
                    kind={blockTarget.kind}
                    value={blockTarget.value}
                    opened
                    onClose={() => setBlockTarget(null)}
                />
            )}
        </>
    );
}

export default MailUnsubscriber;
