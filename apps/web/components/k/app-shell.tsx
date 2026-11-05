import * as React from "react";
import { fetchIdentityMailboxList } from "@/lib/actions/mailbox";
import { isSignedIn } from "@/lib/actions/auth";
import { fetchWorkspaces } from "@/lib/actions/workspace";
import { getWorkspacePublicId } from "@/lib/actions/clients";
import KMailShell from "@/components/k/mail-shell";
import KPane from "@/components/k/pane";

// Same shell as the mailbox, for the other areas (Contacts, Drive, Platform).
// `action` replaces "New message" (the area's main button), `nav` is the
// area's own navigation.
export default async function KAppShell({
	action,
	nav,
	children,
}: {
	action?: React.ReactNode;
	nav?: React.ReactNode;
	children: React.ReactNode;
}) {
	const [workspacePublicId, identityMailboxes, user, userWorkspaces] = await Promise.all([
		getWorkspacePublicId(),
		fetchIdentityMailboxList(),
		isSignedIn(),
		fetchWorkspaces(),
	]);
	return (
		<KMailShell
			workspacePublicId={workspacePublicId}
			userEmail={user?.email ?? null}
			identities={identityMailboxes.map(({ identity }) => ({
				publicId: identity.publicId,
				value: identity.value,
				displayName: identity.displayName,
			}))}
			workspaces={userWorkspaces.map(({ workspaces }) => ({
				publicId: workspaces.publicId,
				id: workspaces.id,
				name: workspaces.name,
			}))}
			compose={action ? <div className="k-app-action">{action}</div> : null}
			nav={<div className="k-app-nav">{nav}</div>}
		>
			<KPane>{children}</KPane>
		</KMailShell>
	);
}
