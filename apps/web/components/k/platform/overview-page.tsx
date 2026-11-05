// Platform overview (modern interface), same data as the classic interface.
import React from "react";
import Link from "next/link";
import {
	ArrowRight,
	Check,
	Database,
	FileText,
	HardDrive,
	Mail,
	Plug,
	Send,
} from "lucide-react";
import { getDashboardStats } from "@/lib/actions/dashboard";
import { getWorkspacePublicId, getWorkspaceRole } from "@/lib/actions/clients";
import { fetchWorkspace } from "@/lib/actions/workspace";
import { KCard, KFacts, KLinkButton, KMeter, KPage, KStat, fmtBytes, fmtNumber } from "@/components/k/platform/ui";

export default async function KOverviewPage() {
	const { data: s } = await getDashboardStats();
	const workspacePublicId = await getWorkspacePublicId();
	const workspaceRole = await getWorkspaceRole();
	const workspace = await fetchWorkspace();

	const isOwner = workspaceRole === "owner";
	const base = `/w/${workspacePublicId}/dashboard/platform`;
	const totalStorage = s?.totalStorageBytes || s?.storageBytesUsed || 0;

	const stats = isOwner
		? [
				{ icon: <Plug />, label: "Connected providers", value: fmtNumber(s?.connectedProviders), hint: "Sending and storage" },
				{ icon: <Send />, label: "Active identities", value: fmtNumber(s?.activeIdentities), hint: "Mailboxes and senders" },
				{
					icon: <Mail />,
					label: "Stored messages",
					value: fmtNumber(s?.emailsProcessedTotal),
					hint: `${fmtNumber(s?.emailsProcessed24h)} in the last 24 h`,
				},
				{
					icon: <HardDrive />,
					label: "Storage used",
					value: fmtBytes(totalStorage),
					hint: s?.isStorageOverLimit ? "Storage limit exceeded" : "Within the plan limit",
				},
			]
		: [
				{
					icon: <Mail />,
					label: "Messages",
					value: fmtNumber(s?.emailsProcessedTotal),
					hint: `${fmtNumber(s?.emailsProcessed24h)} in the last 24 h`,
				},
				{ icon: <FileText />, label: "Conversations", value: fmtNumber(s?.threadCount), hint: "Accessible to you" },
				{
					icon: <Database />,
					label: "Drafts",
					value: fmtNumber(s?.draftCount),
					hint: `${fmtNumber(s?.scheduledDraftCount)} scheduled`,
				},
				{ icon: <HardDrive />, label: "Message storage", value: fmtBytes(s?.rawMessageBytes), hint: "Accessible messages" },
			];

	const steps = [
		{
			title: "Connect a provider",
			text: "Add SES, Postmark, SendGrid, Mailgun or an SMTP account.",
			done: Number(s?.connectedProviders || 0) > 0,
			href: `${base}/providers`,
		},
		{
			title: "Verify a domain",
			text: "Add the DNS records and confirm domain ownership.",
			done: Number(s?.verifiedDomains || 0) > 0,
			href: `${base}/identities`,
		},
		{
			title: "Create an identity",
			text: "Create an email address to send or receive.",
			done: Number(s?.activeIdentities || 0) > 0,
			href: `${base}/identities`,
		},
		{
			title: "Create a storage volume",
			text: "Add a Drive volume for the workspace files.",
			done: Number(s?.volumeCount || 0) > 0,
			href: `${base}/storage`,
		},
	];
	const doneCount = steps.filter((x) => x.done).length;

	const storageRows: [string, string][] = [
		["Raw messages (EML)", fmtBytes(s?.rawMessageBytes)],
		["Attachments", fmtBytes(s?.attachmentBytes)],
		...(isOwner ? ([["Drive files", fmtBytes(s?.driveStorageBytes)]] as [string, string][]) : []),
		["Total", fmtBytes(totalStorage)],
	];

	return (
		<KPage
			wide
			title={`Welcome to ${workspace?.name || "Kurrier"}`}
			subtitle={
				isOwner
					? "Setup, message volume and storage of the workspace."
					: "Your accessible messages, conversations and drafts."
			}
			actions={
				isOwner ? (
					<div className="hidden gap-2 sm:flex">
						<KLinkButton href={`${base}/identities`}>Create an identity</KLinkButton>
						<KLinkButton href={`${base}/providers`} primary>
							Add a provider
						</KLinkButton>
					</div>
				) : undefined
			}
		>
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				{stats.map((c) => (
					<KStat key={c.label} {...c} />
				))}
			</div>

			<div className={isOwner ? "grid gap-4 lg:grid-cols-[1fr_1fr]" : "grid gap-4"}>
				{isOwner && (
					<KCard
						title="Setup steps"
						description={`${doneCount} of ${steps.length} completed`}
					>
						<KMeter value={(doneCount / steps.length) * 100} />
						<div className="mt-3 -mx-2 space-y-0.5">
							{steps.map((x) => (
								<Link
									key={x.title}
									href={x.href}
									className="group flex items-start gap-3 rounded-k-sm px-2 py-2.5 transition-colors hover:bg-k-hover"
								>
									<span
										className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
											x.done
												? "border-transparent bg-k-accent text-k-accent-ink"
												: "border-k-line-strong text-transparent"
										}`}
									>
										<Check size={12} strokeWidth={3} />
									</span>
									<span className="min-w-0 flex-1">
										<span className={`block text-[13.5px] font-medium ${x.done ? "text-k-ink-3 line-through" : "text-k-ink"}`}>
											{x.title}
										</span>
										<span className="mt-0.5 block text-[12.5px] text-k-ink-3">{x.text}</span>
									</span>
									<ArrowRight size={15} className="mt-1 shrink-0 text-k-ink-3 transition-transform group-hover:translate-x-0.5" />
								</Link>
							))}
						</div>
					</KCard>
				)}

				<KCard
					title="Message flow"
					description={isOwner ? "Workspace activity." : "Activity you have access to."}
				>
					<KFacts
						rows={[
							["Total messages", fmtNumber(s?.emailsProcessedTotal)],
							["Last 24 h", fmtNumber(s?.emailsProcessed24h)],
							["Conversations", fmtNumber(s?.threadCount)],
							["Drafts", fmtNumber(s?.draftCount)],
							["Scheduled drafts", fmtNumber(s?.scheduledDraftCount)],
							["Attachments", fmtNumber(s?.attachmentCount)],
						]}
					/>
				</KCard>
			</div>

			<div className={`grid gap-4 ${isOwner ? "md:grid-cols-2" : ""}`}>
				<KCard title="Storage" description="Breakdown of the space used.">
					<KFacts rows={storageRows} />
				</KCard>
				{isOwner && (
					<KCard title="Configuration" description="What is set up in the workspace.">
						<KFacts
							rows={[
								["Providers", fmtNumber(s?.connectedProviders)],
								["Verified domains", fmtNumber(s?.verifiedDomains)],
								["Identities", fmtNumber(s?.activeIdentities)],
								["Volumes", fmtNumber(s?.volumeCount)],
								["Drive entries", fmtNumber(s?.driveEntryCount)],
							]}
						/>
					</KCard>
				)}
			</div>
		</KPage>
	);
}
