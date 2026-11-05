"use client";
import React from "react";
import { Divider } from "@mantine/core";
import { useModernUi } from "@/components/k/ui-context";

export default function SectionCard({
                         title,
                         description,
                         children,
                         footer,
                     }: {
    title: string;
    description?: string;
    children: React.ReactNode;
    footer?: React.ReactNode;
}) {
    // Settings card of the modern interface (white surface, thin border).
    if (useModernUi()) {
        return (
            <section className="rounded-k-pane border border-k-line bg-k-surface shadow-k-pane">
                <div className="px-5 pb-1 pt-4">
                    <h2 className="text-[15px] font-semibold tracking-tight text-k-ink">{title}</h2>
                    {description ? (
                        <p className="mt-1 text-[13px] leading-relaxed text-k-ink-2">{description}</p>
                    ) : null}
                </div>
                <div className="px-5 py-4">{children}</div>
                {footer ? (
                    <div className="border-t border-k-line px-5 py-3">{footer}</div>
                ) : null}
            </section>
        );
    }
    return (
        <div className="rounded-2xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <div className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-50">
                            {title}
                        </h2>
                        {description ? (
                            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                                {description}
                            </p>
                        ) : null}
                    </div>
                </div>
            </div>
            <div className="px-5 py-4">{children}</div>
            {footer ? (
                <>
                    <Divider />
                    <div className="px-5 py-4">{footer}</div>
                </>
            ) : null}
        </div>
    );
}
