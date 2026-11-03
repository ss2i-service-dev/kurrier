"use client";
// ss2i : cles d'API (nouvelle interface). Meme action serveur que la classique.
import * as React from "react";
import { ActionIcon, TagsInput } from "@mantine/core";
import { Copy, Key } from "lucide-react";
import { toast } from "sonner";
import { ulid } from "ulid";
import { apiScopeOptions } from "@schema";
import { addApiKey, FetchUserAPIKeysResult } from "@/lib/actions/dashboard";
import { ReusableForm } from "@/components/common/reusable-form";
import { KBadge, KCard, KEmpty, fmtDateTime } from "@/components/k/platform/ui";

export default function KApiKeys({ apiKeysList }: { apiKeysList: FetchUserAPIKeysResult }) {
	const copy = (raw: string) => {
		navigator.clipboard.writeText(raw);
		toast.info("Clé d'API copiée");
	};

	const fields = [
		{ name: "ulid", wrapperClasses: "hidden", props: { hidden: true, defaultValue: ulid() } },
		{
			name: "name",
			label: "Nom de la clé",
			wrapperClasses: "col-span-12 sm:col-span-6",
			props: { required: true, placeholder: "ex. Intégration CRM" },
		},
		{
			name: "scope",
			label: "Portées",
			kind: "custom" as const,
			options: apiScopeOptions,
			component: TagsInput,
			required: true,
			wrapperClasses: "col-span-12 sm:col-span-6",
			props: {
				data: apiScopeOptions,
				readOnly: true,
				defaultValue: apiScopeOptions[0] ? apiScopeOptions.map((aO) => aO.value) : [],
				required: true,
				className: "w-full",
			},
		},
	];

	return (
		<>
			<KCard
				title="Nouvelle clé"
				description="Créez une clé pour un accès de serveur à serveur. Elle est liée à votre espace de travail."
			>
				<ReusableForm
					action={addApiKey}
					fields={fields}
					submitButtonProps={{
						submitLabel: "Créer la clé",
						wrapperClasses: "mt-5 flex justify-end",
						fullWidth: false,
					}}
				/>
			</KCard>

			<KCard flush title="Clés existantes" description="Copiez la clé pour l'utiliser dans vos intégrations.">
				{apiKeysList.length === 0 ? (
					<KEmpty icon={<Key />} title="Aucune clé d'API" text="Les clés que vous créez apparaîtront ici." />
				) : (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[560px] text-left text-[13px]">
							<thead>
								<tr className="border-y border-k-line bg-k-surface-2 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-k-ink-3">
									<th className="px-5 py-2">Nom</th>
									<th className="px-3 py-2">Identifiant</th>
									<th className="px-3 py-2">Portées</th>
									<th className="px-3 py-2">Création</th>
									<th className="w-12 px-5 py-2" />
								</tr>
							</thead>
							<tbody className="divide-y divide-k-line">
								{apiKeysList.map((k) => (
									<tr key={k.id} className="hover:bg-k-hover/50">
										<td className="px-5 py-3 font-medium text-k-ink">{k.name}</td>
										<td className="px-3 py-3 font-mono text-[11.5px] text-k-ink-2">{k.id}</td>
										<td className="px-3 py-3">
											<div className="flex flex-wrap gap-1">
												{k.scopes.map((s) => (
													<KBadge key={s} tone="accent">
														{s}
													</KBadge>
												))}
											</div>
										</td>
										<td className="whitespace-nowrap px-3 py-3 text-k-ink-2">{fmtDateTime(k.createdAt)}</td>
										<td className="px-5 py-3 text-right">
											<ActionIcon
												variant="subtle"
												color="gray"
												title="Copier la clé d'API"
												aria-label="Copier la clé d'API"
												onClick={() => copy(k.vault.rawKey)}
											>
												<Copy size={15} />
											</ActionIcon>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</KCard>
		</>
	);
}
