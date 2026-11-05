// Workspace page (modern interface): details and members.
import React from "react";
import { ReusableForm } from "@/components/common/reusable-form";
import { fetchWorkspace, fetchWorkspaceMembers, updateWorkspace } from "@/lib/actions/workspace";
import { KBadge, KCard, KEmpty, KPage } from "@/components/k/platform/ui";
import KAvatar from "@/components/k/avatar";
import { Users } from "lucide-react";

export default async function KWorkspacePage() {
	const workspace = await fetchWorkspace();
	const members = await fetchWorkspaceMembers(workspace?.id);

	const fields = [
		{
			name: "name",
			label: "Workspace name",
			wrapperClasses: "col-span-12",
			props: { defaultValue: workspace.name },
		},
	];

	return (
		<KPage
			title="Workspace"
			subtitle="Workspace settings and its members."
		>
			<KCard title="Details" description="Edit your workspace information.">
				<ReusableForm
					fields={fields}
					action={updateWorkspace}
					notify={{
						kind: "toast",
						successMessage: "Workspace updated.",
						errorMessage: "Error updating the workspace.",
					}}
					submitButtonProps={{
						wrapperClasses: "mt-5 flex justify-end",
						submitLabel: "Save",
						fullWidth: false,
					}}
				/>
			</KCard>

			<KCard flush title="Members" description="People with access to this workspace.">
				{!members || members.length === 0 ? (
					<KEmpty icon={<Users />} title="No members" />
				) : (
					<div className="divide-y divide-k-line border-t border-k-line">
						{members.map((m) => (
							<div key={m.workspace_members.id} className="flex items-center justify-between gap-3 px-5 py-3">
								<div className="flex min-w-0 items-center gap-3">
									<KAvatar name={m.users?.email} email={m.users?.email} size={30} />
									<span className="truncate text-[13.5px] text-k-ink">{m.users?.email}</span>
								</div>
								<KBadge tone={m.workspace_members.role === "owner" ? "accent" : "neutral"}>
									{m.workspace_members.role === "owner" ? "Owner" : "Member"}
								</KBadge>
							</div>
						))}
					</div>
				)}
			</KCard>
		</KPage>
	);
}
