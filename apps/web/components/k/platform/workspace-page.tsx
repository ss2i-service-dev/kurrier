// ss2i : page Espace de travail (nouvelle interface) : details et membres.
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
			label: "Nom de l'espace de travail",
			wrapperClasses: "col-span-12",
			props: { defaultValue: workspace.name },
		},
	];

	return (
		<KPage
			title="Espace de travail"
			subtitle="Réglages de l'espace de travail et de ses membres."
		>
			<KCard title="Détails" description="Modifiez les informations de votre espace de travail.">
				<ReusableForm
					fields={fields}
					action={updateWorkspace}
					notify={{
						kind: "toast",
						successMessage: "Espace de travail mis à jour.",
						errorMessage: "Erreur lors de la mise à jour de l'espace de travail.",
					}}
					submitButtonProps={{
						wrapperClasses: "mt-5 flex justify-end",
						submitLabel: "Enregistrer",
						fullWidth: false,
					}}
				/>
			</KCard>

			<KCard flush title="Membres" description="Personnes ayant accès à cet espace de travail.">
				{!members || members.length === 0 ? (
					<KEmpty icon={<Users />} title="Aucun membre" />
				) : (
					<div className="divide-y divide-k-line border-t border-k-line">
						{members.map((m) => (
							<div key={m.workspace_members.id} className="flex items-center justify-between gap-3 px-5 py-3">
								<div className="flex min-w-0 items-center gap-3">
									<KAvatar name={m.users?.email} email={m.users?.email} size={30} />
									<span className="truncate text-[13.5px] text-k-ink">{m.users?.email}</span>
								</div>
								<KBadge tone={m.workspace_members.role === "owner" ? "accent" : "neutral"}>
									{m.workspace_members.role === "owner" ? "Propriétaire" : "Membre"}
								</KBadge>
							</div>
						))}
					</div>
				)}
			</KCard>
		</KPage>
	);
}
