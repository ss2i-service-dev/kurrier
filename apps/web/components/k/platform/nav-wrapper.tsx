// Navigation of the Platform section (modern interface), server side.
import React from "react";
import KPlatformNav from "@/components/k/platform/nav";
import { getWorkspacePublicId, getWorkspaceRole } from "@/lib/actions/clients";

export default async function KPlatformNavWrapper() {
	const [workspacePublicId, workspaceRole] = await Promise.all([getWorkspacePublicId(), getWorkspaceRole()]);
	return <KPlatformNav workspacePublicId={workspacePublicId} workspaceRole={workspaceRole || "member"} />;
}
