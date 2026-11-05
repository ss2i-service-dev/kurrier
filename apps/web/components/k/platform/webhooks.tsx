"use client";
// Webhooks (modern interface). Same server actions as the classic interface.
import * as React from "react";
import { Select, TagsInput } from "@mantine/core";
import { Webhook, X } from "lucide-react";
import { ulid } from "ulid";
import { FieldConfig, webHookListOptions } from "@schema";
import { addWebhook, deleteWebhook, FetchUserWebhooksResult } from "@/lib/actions/dashboard";
import { ReusableForm } from "@/components/common/reusable-form";
import { ReusableFormButton } from "@/components/common/reusable-form-button";
import { KBadge, KCard, KEmpty, fmtDateTime } from "@/components/k/platform/ui";

export default function KWebhooks({
	hooksList,
	identitiesOptions,
}: {
	hooksList: FetchUserWebhooksResult;
	identitiesOptions: { label: string; value: string }[];
}) {
	if (identitiesOptions.length === 0) {
		return (
			<KCard>
				<KEmpty
					icon={<Webhook />}
					title="No identities available"
					text="Create an identity to use webhooks."
				/>
			</KCard>
		);
	}

	const fields: FieldConfig[] = [
		{ name: "ulid", wrapperClasses: "hidden", props: { hidden: true, defaultValue: ulid() } },
		{
			name: "url",
			label: "Endpoint URL",
			wrapperClasses: "col-span-12",
			props: { required: true, placeholder: "https://example.com/webhook" },
		},
		{
			name: "identityId",
			label: "Identity",
			wrapperClasses: "col-span-12 sm:col-span-6",
			kind: "custom",
			component: Select,
			props: {
				data: identitiesOptions,
				searchable: true,
				required: true,
				allowDeselect: false,
				clearable: false,
				defaultValue: identitiesOptions[0]?.value,
				nothingFoundMessage: "No identities found",
			},
		},
		{
			name: "scope",
			label: "Events",
			kind: "custom" as const,
			options: webHookListOptions,
			component: TagsInput,
			wrapperClasses: "col-span-12 sm:col-span-6",
			props: {
				data: webHookListOptions,
				readOnly: true,
				defaultValue: webHookListOptions[0] ? webHookListOptions.map((aO) => aO.value) : [],
				required: true,
				className: "w-full",
			},
		},
	];

	return (
		<>
			<KCard
				title="New webhook"
				description="Get a real-time notification, at the address of your choice, for every new message received."
			>
				<ReusableForm
					action={addWebhook}
					fields={fields}
					submitButtonProps={{
						submitLabel: "Create webhook",
						wrapperClasses: "mt-5 flex justify-end",
						fullWidth: false,
					}}
				/>
			</KCard>

			<KCard flush title="Existing webhooks">
				{hooksList.length === 0 ? (
					<KEmpty icon={<Webhook />} title="No webhooks" text="Webhooks you create will appear here." />
				) : (
					<div className="overflow-x-auto">
						<table className="w-full min-w-[640px] text-left text-[13px]">
							<thead>
								<tr className="border-y border-k-line bg-k-surface-2 text-[11.5px] font-semibold uppercase tracking-[0.05em] text-k-ink-3">
									<th className="px-5 py-2">URL</th>
									<th className="px-3 py-2">Identity</th>
									<th className="px-3 py-2">Event</th>
									<th className="px-3 py-2">Created</th>
									<th className="px-5 py-2 text-right">Action</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-k-line">
								{hooksList.map((hook) => (
									<tr key={hook.webhooks.id} className="hover:bg-k-hover/50">
										<td className="max-w-[260px] break-all px-5 py-3 font-mono text-[11.5px] text-k-ink">
											{hook.webhooks.url}
										</td>
										<td className="px-3 py-3 text-k-ink-2">{hook.identities.value ?? "-"}</td>
										<td className="px-3 py-3">
											<KBadge tone="accent">message.received</KBadge>
										</td>
										<td className="whitespace-nowrap px-3 py-3 text-k-ink-2">{fmtDateTime(hook.webhooks.createdAt)}</td>
										<td className="px-5 py-3">
											<div className="flex justify-end">
												<ReusableFormButton
													action={deleteWebhook}
													label="Delete"
													buttonProps={{
														leftSection: <X size={14} />,
														size: "compact-xs",
														variant: "light",
														color: "red",
													}}
												>
													<input type="hidden" name="id" value={hook.webhooks.id} />
												</ReusableFormButton>
											</div>
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
