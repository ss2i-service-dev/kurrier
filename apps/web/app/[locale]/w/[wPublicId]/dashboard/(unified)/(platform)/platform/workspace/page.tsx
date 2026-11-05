import { isModernUi } from "@/lib/actions/interface-pref";
import KWorkspacePage from "@/components/k/platform/workspace-page";
import React from "react";
import WorkspacesGeneral from "@/components/dashboard/workspaces/workspaces-general";

async function ClassicPage() {
    return (
        <>
            <WorkspacesGeneral />
        </>
    );
}

// Modern interface (per-user option): page rebuilt in components/k/platform.
export default async function Page() {
	if (!(await isModernUi())) return <ClassicPage />;
	return <KWorkspacePage />;
}
