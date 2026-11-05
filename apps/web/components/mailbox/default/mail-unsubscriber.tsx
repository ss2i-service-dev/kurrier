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

// One-click unsubscribe (see lib/actions/unsubscribe.ts). The button is featured in the
// mail header; the result is always visible (toast, then badge).
type BlockTarget = { kind: "address" | "domain"; value: string };

function UnsubscribeControl({ mailSubscription, message, onBlock }: {
    message: MessageEntity;
    mailSubscription: MailSubscriptionEntity | null;
    onBlock: (t: BlockTarget) => void;
}) {
    const pathname = usePathname();
    const [busy, setBusy] = useState(false);
    // Local state: the page is not necessarily reloaded after the action.
    const [local, setLocal] = useState<"unsubscribed" | "pending" | null>(null);
    if (!mailSubscription) return null;

    const status = local ?? (mailSubscription.status === "unsubscribed" || mailSubscription.status === "pending"
        ? mailSubscription.status
        : null);
    const method = chooseUnsubscribeMethod(mailSubscription);

    if (status === "unsubscribed") {
        return (
            <Badge size="sm" color="gray" variant="light" className="mt-0.5">
                {"Unsubscribed"}
            </Badge>
        );
    }

    const markDone = async () => {
        const res = await confirmUnsubscribed({ mailSubscriptionId: mailSubscription.id, pathname });
        if (res.success) {
            setLocal("unsubscribed");
            toast.success("Unsubscribed", { position: "bottom-left" });
        } else {
            toast.error(res.error ?? "Update failed", { position: "bottom-left" });
        }
    };

    if (status === "pending") {
        return (
            <div className="flex items-center gap-2">
                <Badge size="sm" color="yellow" variant="light">
                    {"Finish on the sender's page"}
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
                        {"Reopen"}
                    </Button>
                )}
                <Button size="compact-xs" variant="light" onClick={markDone}>
                    {"Done"}
                </Button>
            </div>
        );
    }

    if (method === "none") {
        return (
            <Badge size="sm" color="gray" variant="light">
                {"No unsubscribe link"}
            </Badge>
        );
    }

    const run = async () => {
        setBusy(true);
        // The web link page is opened right away, within the click gesture (otherwise the
        // browser blocks the window); the server marks the subscription "pending".
        const win = method === "web" ? window.open("about:blank", "_blank") : null;
        try {
            const res = await unsubscribeFromMail({
                mailSubscriptionId: mailSubscription.id,
                messageId: message.id,
                pathname,
            });
            if (!res.success || !res.data) {
                win?.close();
                toast.error(res.error ?? "Unsubscribe failed", { position: "bottom-left", duration: 8000 });
                return;
            }
            const { status: st, domain, openUrl, block } = res.data;
            if (st === "pending") {
                if (win && openUrl) win.location.href = openUrl;
                else if (openUrl) window.open(openUrl, "_blank");
                setLocal("pending");
                toast.message("Finish on the sender's page", {
                    position: "bottom-left",
                    description: "Complete the unsubscribe on the page that just opened, then press Done.",
                    duration: 10000,
                });
                return;
            }
            setLocal("unsubscribed");
            const target = block.domain
                ? { kind: "domain" as const, value: block.domain }
                : { kind: "address" as const, value: block.address };
            toast.success(`Unsubscribed from ${domain || target.value}`, {
                position: "bottom-left",
                duration: 12000,
                action: target.value
                    ? { label: `Also block ${target.value}`, onClick: () => onBlock(target) }
                    : undefined,
            });
        } catch (e: any) {
            win?.close();
            toast.error(e?.message ?? "Unsubscribe failed", { position: "bottom-left", duration: 8000 });
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
                    ? "Unsubscribe automatically"
                    : method === "mailto"
                      ? "Send the unsubscribe mail automatically"
                      : "Open the sender's unsubscribe page"
            }
        >
            {"Unsubscribe"}
        </Button>
    );
}

// The block modal lives outside the control: the control turns into a badge after unsubscribing.
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
