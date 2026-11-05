"use client";
// CalDAV / CardDAV sync services (modern interface).
import * as React from "react";
import { ActionIcon, Button, TextInput, Tooltip } from "@mantine/core";
import { Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { regenerateDavPassword } from "@/lib/actions/dashboard";
import { KCard } from "@/components/k/platform/ui";

export default function KSyncServices({
	username,
	password,
	baseDavUrl,
}: {
	username: string;
	password?: string;
	baseDavUrl: string;
}) {
	const [isSaving, setIsSaving] = React.useState(false);
	const copy = (value: string, label: string) => {
		if (!value) {
			toast.error(`Nothing to copy for ${label}`);
			return;
		}
		navigator.clipboard.writeText(value);
		toast.success(`${label} copied`);
	};
	const base = baseDavUrl?.replace(/\/+$/, "") || "";
	const userRoot = `${base.replace("https://", "")}`;
	const rows = [
		{ label: "CalDAV (calendar)", url: userRoot },
		{ label: "CardDAV (contacts)", url: userRoot },
	];
	const copyBtn = (value: string, label: string, tip: string) => (
		<Tooltip label={tip} withArrow>
			<ActionIcon variant="subtle" color="gray" aria-label={tip} onClick={() => copy(value, label)}>
				<Copy size={15} />
			</ActionIcon>
		</Tooltip>
	);

	return (
		<>
			<KCard
				title="DAV credentials"
				description="Used by your calendar and contacts apps. They are separate from your Kurrier login."
			>
				<div className="grid gap-5 md:grid-cols-2">
					<div className="space-y-1.5">
						<TextInput
							label="DAV username"
							value={username}
							readOnly
							classNames={{ input: "font-mono !text-xs" }}
							rightSection={copyBtn(username, "DAV username", "Copy username")}
						/>
						<p className="text-[12px] text-k-ink-3">Enter this as the account name in your CalDAV / CardDAV apps.</p>
					</div>
					<div className="space-y-1.5">
						<TextInput
							label="DAV password"
							value={password ?? ""}
							readOnly
							placeholder="Generate a password to show it here."
							classNames={{ input: "font-mono !text-xs" }}
							rightSection={copyBtn(String(password ?? ""), "DAV password", "Copy password")}
						/>
						<p className="text-[12px] text-k-ink-3">
							A password you create or renew is shown here so you can copy it to your devices.
						</p>
						<div className="pt-1">
							<Button
								type="button"
								size="xs"
								loading={isSaving}
								leftSection={<KeyRound size={14} />}
								onClick={async () => {
									setIsSaving(true);
									await regenerateDavPassword();
									setIsSaving(false);
								}}
							>
								{password ? "Regenerate password" : "Generate a password"}
							</Button>
						</div>
					</div>
				</div>
			</KCard>

			<KCard
				flush
				title="Connection URL"
				description="Use it to add a CalDAV or CardDAV account on your devices. Most apps accept the full URL or the /.well-known endpoints."
			>
				<div className="divide-y divide-k-line border-t border-k-line">
					{rows.map((row) => (
						<div key={row.label} className="flex items-center justify-between gap-3 px-5 py-3">
							<div className="min-w-0">
								<div className="text-[13px] font-medium text-k-ink">{row.label}</div>
								<div className="mt-0.5 break-all font-mono text-[12px] text-k-ink-2">{row.url}</div>
							</div>
							{copyBtn(row.url, `${row.label} URL`, "Copy URL")}
						</div>
					))}
				</div>
			</KCard>

			<KCard title="Usage">
				<ul className="list-disc space-y-1.5 pl-4 text-[13px] text-k-ink-2">
					<li>If you are asked for a server or account URL, paste the matching CalDAV or CardDAV URL.</li>
					<li>Enter the DAV username and password when the device asks you to sign in.</li>
					<li>If syncing fails after a password change, update it on each device.</li>
				</ul>
			</KCard>
		</>
	);
}
