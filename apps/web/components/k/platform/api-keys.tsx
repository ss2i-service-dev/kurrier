"use client";
// API keys (modern interface). Same server action as the classic interface.
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
		toast.info("API key copied");
	};

	const fields = [
		{ name: "ulid", wrapperClasses: "hidden", props: { hidden: true, defaultValue: ulid() } },
		{
			name: "name",
			label: "Key name",
			wrapperClasses: "col-span-12 sm:col-span-6",
			props: { required: true, placeholder: "e.g. Zapier integration" },
		},
		{
			name: "scope",
			label: "Scopes",
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
				title="New key"
				description="Create a key for server-to-server access. It is tied to your workspace."
			>
				<ReusableForm
					action={addApiKey}
					fields={fields}
					submitButtonProps={{
						submitLabel: "Create key",
						wrapperClasses: "mt-5 flex justify-end",
						fullWidth: false,
					}}
				/>
			</KCard>

			<KCard flush title="Existing keys" description="Copy the key to use it in your integrations.">
				{apiKeysList.length === 0 ? (
					<KEmpty icon={<Key />} title="No API keys" text="Keys you create will appear here." />
				) : (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[560px] text-left text-[13px]">
							<thead>
								<tr className="border-y border-k-line bg-k-surface-2 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-k-ink-3">
									<th className="px-5 py-2">Name</th>
									<th className="px-3 py-2">ID</th>
									<th className="px-3 py-2">Scopes</th>
									<th className="px-3 py-2">Created</th>
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
												title="Copy API key"
												aria-label="Copy API key"
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
