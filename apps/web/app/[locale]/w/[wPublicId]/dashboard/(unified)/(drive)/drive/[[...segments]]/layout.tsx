import React from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import DriveTopBar from "@/components/dashboard/drive/drive-top-bar";
import { normalizeWithinPath } from "@/lib/actions/drive";
import { isSignedIn } from "@/lib/actions/auth";
import {getWorkspacePublicId} from "@/lib/actions/clients";
import { isModernUi } from "@/lib/actions/interface-pref";
import KDriveHeader from "@/components/k/drive-header";

async function ClassicDriveSegmentsLayout({
                                                      children,
                                                      params,
                                                  }: {
    children: React.ReactNode;
    params: Record<any, any>;
}) {
    const { segments } = await params;
    const ctx = await normalizeWithinPath(segments ?? []);
    const user = await isSignedIn();
    const workspacePublicId = await getWorkspacePublicId()

    return (
        <>
            <header className="flex items-center gap-2 border-b  bg-background/60 backdrop-blur py-4 px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator
                    orientation="vertical"
                    className="data-[orientation=vertical]:h-4"
                />
                <DriveTopBar ctx={ctx} userId={String(user?.id)} workspacePublicId={workspacePublicId} />
            </header>

            <main>
                <section className="">{children}</section>
            </main>
        </>
    );
}

// Modern interface (per-user option): header with breadcrumb and actions, then
// the content.
export default async function DriveSegmentsLayout(props: {
    children: React.ReactNode;
    params: Record<any, any>;
}) {
    if (!(await isModernUi())) return <ClassicDriveSegmentsLayout {...props} />;

    const { segments } = await props.params;
    const ctx = await normalizeWithinPath(segments ?? []);
    const user = await isSignedIn();
    const workspacePublicId = await getWorkspacePublicId();

    return (
        <>
            <KDriveHeader ctx={ctx} userId={String(user?.id)} workspacePublicId={workspacePublicId} />
            <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
        </>
    );
}
