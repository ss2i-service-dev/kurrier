import { isNouvelleInterface } from "@/lib/actions/interface-pref";
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

// ss2i : nouvelle interface (option par utilisateur) : page refaite dans components/k/platform.
export default async function Page() {
	if (!(await isNouvelleInterface())) return <ClassicPage />;
	return <KWorkspacePage />;
}
