"use client";
// Identities (domains and addresses) of the modern interface. Same server
// actions and same add forms as the classic interface.
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { ActionIcon, Button, CopyButton, Tooltip } from "@mantine/core";
import { modals } from "@mantine/modals";
import { toast } from "sonner";
import {
	ArrowDownFromLine,
	ArrowUpFromLine,
	BadgeCheck,
	BadgeMinus,
	Check,
	CheckCircle,
	Clock,
	Copy,
	Eye,
	Globe,
	LoaderCircle,
	Mail,
	Plus,
	RefreshCw,
	Repeat2,
	Send,
	Trash2,
	XCircle,
} from "lucide-react";
import { parseSecret } from "@/lib/utils";
import {
	deleteDomainIdentity,
	deleteEmailIdentity,
	FetchDecryptedSecretsResult,
	FetchUserIdentitiesResult,
	getIdentityById,
	testSendingEmail,
	verifyDomainIdentity,
} from "@/lib/actions/dashboard";
import { IdentityStatus } from "@schema";
import { DnsRecord } from "@providers";
import { WorkspaceEntity } from "@db";
import { FetchAdminWorkspaceIdentitiesResult, FetchWorkspaceMembersResult } from "@/lib/actions/workspace";
import AddEmailIdentityForm from "@/components/dashboard/identities/add-email-identity-form";
import AddDomainIdentityForm from "@/components/dashboard/identities/add-domain-identity-form";
import { PROVIDER_CONFIG } from "@/components/dashboard/identities/PROVIDER_CONFIG";
import { KBadge, KCard, KEmpty, KRow } from "@/components/k/platform/ui";

const STATUS_INFO: Record<IdentityStatus, { label: string; note: string }> = {
	unverified: { label: "Not verified", note: "Verification has not been started yet." },
	pending: {
		label: "DNS not configured",
		note: "Add the DNS records at your DNS host to continue verification.",
	},
	verified: { label: "Verified", note: "This identity is fully verified and ready to use." },
	failed: {
		label: "Verification failed",
		note: "Check your DNS records or run the verification again.",
	},
};

function OkBadge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
	return (
		<KBadge tone={ok ? "ok" : "danger"} icon={ok ? <BadgeCheck /> : <BadgeMinus />}>
			{children}
		</KBadge>
	);
}

/** Incoming / outgoing status of an address attached to a domain. */
function EmailStatus({ userIdentity }: { userIdentity: FetchUserIdentitiesResult[number] }) {
	const [incoming, setIncoming] = useState(false);
	useEffect(() => {
		const id = userIdentity.identities.domainIdentityId;
		if (!id) return;
		let cancelled = false;
		getIdentityById(id).then((domain) => {
			if (!cancelled) setIncoming(!!domain.incomingDomain);
		});
		return () => {
			cancelled = true;
		};
	}, [userIdentity]);
	return (
		<>
			<OkBadge ok>Sending verified</OkBadge>
			<OkBadge ok={incoming}>Receiving {incoming ? "verified" : "not verified"}</OkBadge>
		</>
	);
}

/** How the identity is tied to the workspace (default, shared, assigned). */
function DefaultBadges({
	workspace,
	userIdentity,
	workspaceUserIdentities,
}: {
	workspace: WorkspaceEntity;
	userIdentity: FetchUserIdentitiesResult[number]["identities"];
	workspaceUserIdentities: FetchAdminWorkspaceIdentitiesResult;
}) {
	const userEmail = workspaceUserIdentities.find((w) => w.workspace_identity_members.identityId === userIdentity.id)?.users
		?.email;
	return (
		<>
			{userIdentity.id === workspace.defaultIdentityId ? (
				<KBadge tone="accent" icon={<CheckCircle />}>
					Default
				</KBadge>
			) : (
				<Tooltip label={userEmail ?? "Not assigned"} withArrow>
					<span>
						<KBadge>Assigned to {userIdentity.displayName}</KBadge>
					</span>
				</Tooltip>
			)}
			{userIdentity.sharedWithWorkspace && (
				<Tooltip label="Default identities are shared with all workspace members" withArrow>
					<span>
						<KBadge tone="accent" icon={<Repeat2 />}>
							Shared with the workspace
						</KBadge>
					</span>
				</Tooltip>
			)}
		</>
	);
}

function CopyField({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex items-start gap-2 text-[12.5px]">
			<span className="w-14 shrink-0 pt-0.5 text-k-ink-3">{label}</span>
			<code className="min-w-0 flex-1 break-all rounded bg-k-hover px-1.5 py-0.5 font-mono text-[12px] text-k-ink">
				{value}
			</code>
			<CopyButton value={value} timeout={1500}>
				{({ copied, copy }) => (
					<Tooltip label={copied ? "Copied" : "Copy"} withArrow>
						<ActionIcon variant="subtle" color={copied ? "teal" : "gray"} size="sm" onClick={copy} aria-label="Copy">
							{copied ? <Check size={14} /> : <Copy size={14} />}
						</ActionIcon>
					</Tooltip>
				)}
			</CopyButton>
		</div>
	);
}

export default function KIdentities({
	userIdentities,
	smtpAccounts,
	providerAccounts,
	providerOptions,
	workspace,
	workspaceMembers,
	workspaceUserIdentities,
}: {
	userIdentities: FetchUserIdentitiesResult;
	smtpAccounts: FetchDecryptedSecretsResult;
	providerAccounts: FetchDecryptedSecretsResult;
	providerOptions: { label: string; value: string }[];
	workspace: WorkspaceEntity;
	workspaceMembers: FetchWorkspaceMembersResult;
	workspaceUserIdentities: FetchAdminWorkspaceIdentitiesResult;
}) {
	const emails = useMemo(() => userIdentities.filter((i) => i.identities.kind === "email"), [userIdentities]);
	const domains = useMemo(() => userIdentities.filter((i) => i.identities.kind === "domain"), [userIdentities]);
	const [sendingId, setSendingId] = useState<string | null>(null);
	const [verifyingId, setVerifyingId] = useState<string | null>(null);

	const testEmail = async (u: FetchUserIdentitiesResult[number], secrets: Record<any, unknown>) => {
		setSendingId(u.identities.id);
		const res = await testSendingEmail(u, secrets);
		if (res.success) toast.success("Test message sent", { description: res.message });
		else toast.error("Failed to send the test message", { description: res.message });
		setSendingId(null);
	};

	const openAddEmail = () => {
		const id = modals.open({
			title: "Add an email address",
			closeOnEscape: false,
			closeOnClickOutside: false,
			size: "lg",
			children: (
				<div className="pb-2 pt-1">
					<AddEmailIdentityForm
						smtpAccounts={smtpAccounts}
						providerOptions={providerOptions}
						providerAccounts={providerAccounts}
						userDomainIdentities={domains}
						workspaceMembers={workspaceMembers}
						userEmailIdentities={emails}
						onCompleted={() => modals.close(id)}
					/>
				</div>
			),
		});
	};

	const openAddDomain = () => {
		const id = modals.open({
			title: "Add a domain",
			closeOnEscape: false,
			closeOnClickOutside: false,
			size: "lg",
			children: (
				<div className="pb-2 pt-1">
					<AddDomainIdentityForm
						providerOptions={providerOptions}
						providerAccounts={providerAccounts}
						onCompleted={() => modals.close(id)}
					/>
				</div>
			),
		});
	};

	// Deletion with a progress window, then a result window (domain or address).
	const runDelete = async (
		value: string,
		doDelete: () => Promise<{ success?: boolean; message?: string }>,
		okToast: string,
		koToast: string,
	) => {
		const modalId = modals.open({
			title: "Deleting",
			centered: true,
			closeOnEscape: false,
			closeOnClickOutside: false,
			withCloseButton: false,
			children: (
				<div className="space-y-4 pb-2">
					<p className="text-[13.5px] text-k-ink-2">
						Deleting <b className="text-k-ink">{value}</b>. This may take a moment.
					</p>
					<div className="flex justify-center py-3">
						<LoaderCircle className="h-7 w-7 animate-spin text-k-accent" />
					</div>
				</div>
			),
		});
		const res = await doDelete();
		const ok = !!res.success;
		if (ok) toast.success(okToast);
		else toast.error(koToast);
		modals.updateModal({
			modalId,
			title: ok ? "Identity deleted" : "Deletion failed",
			closeOnEscape: true,
			closeOnClickOutside: true,
			withCloseButton: true,
			children: (
				<div className="space-y-4 pb-2">
					<p className={`text-[13.5px] ${ok ? "text-k-ink-2" : "text-k-danger"}`}>
						{ok ? (
							<>
								<b className="text-k-ink">{value}</b> has been deleted.
							</>
						) : (
							(res.message ?? "Deletion failed.")
						)}
					</p>
					<div className="flex justify-center py-1">
						{ok ? <CheckCircle className="h-7 w-7 text-emerald-600" /> : <XCircle className="h-7 w-7 text-k-danger" />}
					</div>
					<Button fullWidth onClick={() => modals.close(modalId)}>
						Close
					</Button>
				</div>
			),
		});
	};

	const confirmDelete = (u: FetchUserIdentitiesResult[number], domain: boolean) =>
		modals.openConfirmModal({
			title: domain ? "Delete domain" : "Delete identity",
			centered: true,
			children: (
				<div className="text-[13.5px] text-k-ink-2">
					Are you sure you want to delete <b className="text-k-ink">{u.identities.value}</b>? It will be removed
											permanently and its secrets detached.
				</div>
			),
			labels: { confirm: "Delete", cancel: "Cancel" },
			confirmProps: { color: "red" },
			onConfirm: () => {
				if (domain) {
					const providerAccount = providerAccounts.find((a) => a.linkRow.providerId === u.identities.providerId);
					return runDelete(
						u.identities.value,
						() => deleteDomainIdentity(u, providerAccount) as any,
						"Domain deleted",
						"Failed to delete the domain",
					);
				}
				return runDelete(
					u.identities.value,
					() => deleteEmailIdentity(u) as any,
					"Identity deleted",
					"Failed to delete the identity",
				);
			},
		});

	const openDns = (u: FetchUserIdentitiesResult[number]) =>
		modals.open({
			title: (
				<span>
					DNS records for <b>{u.identities.value}</b>
				</span>
			),
			closeOnEscape: false,
			closeOnClickOutside: false,
			size: "lg",
			children: (
				<div className="space-y-2.5 pb-2">
					<p className="text-[13px] text-k-ink-2">
						Add these records at your DNS host, then run the verification again. Propagation can take a
													little while.
					</p>
					{u.identities.dnsRecords?.map((record: DnsRecord, i: number) => (
						<div key={i} className="space-y-1.5 rounded-k border border-k-line bg-k-surface-2 p-3">
							<div className="flex items-center justify-between">
								<KBadge tone="accent">{record.type}</KBadge>
								{record.ttl && <span className="text-[12px] text-k-ink-3">TTL: {record.ttl}</span>}
							</div>
							<CopyField label="Name" value={record?.name ? record.name : u.identities.value} />
							<CopyField label="Value" value={record.value} />
							{record.priority && <div className="text-[12.5px] text-k-ink-3">Priority: {record.priority || "10"}</div>}
						</div>
					))}
				</div>
			),
		});

	const verifyDomain = async (u: FetchUserIdentitiesResult[number]) => {
		setVerifyingId(u.identities.id);
		const providerAccount = providerAccounts.find((a) => a.linkRow.providerId === u.identities.providerId);
		const { data: response } = await verifyDomainIdentity(u, providerAccount);
		if (response?.status === "verified") {
			toast.success("Domain verified");
		} else {
			toast.error("Domain verification failed", {
				description:
					"Check your DNS records. If you have just added them, propagation can take a little while.",
			});
		}
		setVerifyingId(null);
	};

	return (
		<>
			<KCard
				flush
				title="Domains"
				description="Sending and receiving domains, verified through DNS with your provider."
				actions={
					<Button size="xs" onClick={openAddDomain} leftSection={<Plus size={14} />}>
						Add a domain
					</Button>
				}
			>
				{domains.length === 0 ? (
					<KEmpty icon={<Globe />} title="No domains" text="Add your first domain to get started." />
				) : (
					domains.map((u) => {
						const status = (u.identities.status as IdentityStatus) in STATUS_INFO ? (u.identities.status as IdentityStatus) : "unverified";
						const meta = STATUS_INFO[status];
						const verified = status === "verified";
						return (
							<KRow
								key={u.identities.id}
								icon={<Globe />}
								title={u.identities.value}
								meta={meta.note}
								badges={
									<>
										<KBadge tone={verified ? "ok" : status === "failed" ? "danger" : "warn"} icon={verified ? <BadgeCheck /> : <Clock />}>
											{meta.label}
										</KBadge>
										{verified && (
											<>
												<KBadge icon={<ArrowUpFromLine />}>Sending</KBadge>
												{u.identities.incomingDomain && <KBadge icon={<ArrowDownFromLine />}>Receiving</KBadge>}
											</>
										)}
									</>
								}
								actions={
									<>
										<Button
											variant="default"
											size="xs"
											loading={verifyingId === u.identities.id}
											onClick={() => verifyDomain(u)}
											leftSection={<RefreshCw size={14} />}
										>
											Verify
										</Button>
										<Button variant="default" size="xs" onClick={() => openDns(u)} leftSection={<Eye size={14} />}>
											DNS records
										</Button>
										<ActionIcon
											variant="light"
											color="red"
											size="md"
											aria-label="Delete domain"
											title="Delete"
											onClick={() => confirmDelete(u, true)}
										>
											<Trash2 size={14} />
										</ActionIcon>
									</>
								}
							/>
						);
					})
				)}
			</KCard>

			<KCard
				flush
				title="Email addresses"
				description="Addresses used to send and receive. Each one relies on a provider or an SMTP account."
				actions={
					<Button size="xs" onClick={openAddEmail} leftSection={<Plus size={14} />}>
						Add an address
					</Button>
				}
			>
				{emails.length === 0 ? (
					<KEmpty icon={<Mail />} title="No email addresses" text="Add your first address to get started." />
				) : (
					emails.map((u) => {
						const providerType = u.smtp_accounts ? "smtp" : (u?.providers?.type as string);
						let decrypted = {} as Record<string, any>;
						if (u?.providers?.id) {
							decrypted = parseSecret(providerAccounts.find((s) => s.linkRow.providerId === u?.providers?.id));
						} else if (u?.smtp_accounts?.id) {
							decrypted = parseSecret(smtpAccounts.find((s) => s.linkRow.accountId === u?.smtp_accounts?.id));
						}
						return (
							<KRow
								key={u.identities.id}
								icon={<Mail />}
								title={u.identities.value}
								meta={<span className="text-[11.5px]">ID: {u.identities.id}</span>}
								badges={
									<>
										<DefaultBadges
											workspace={workspace}
											userIdentity={u.identities}
											workspaceUserIdentities={workspaceUserIdentities}
										/>
										{providerType && PROVIDER_CONFIG[providerType as keyof typeof PROVIDER_CONFIG] && (
											<KBadge>{providerType === "smtp" ? "Custom SMTP" : PROVIDER_CONFIG[providerType as keyof typeof PROVIDER_CONFIG].name}</KBadge>
										)}
										{u.smtp_accounts ? (
											<>
												<OkBadge ok={!!decrypted.sendVerified}>
													Sending {decrypted.sendVerified ? "verified" : "not verified"}
												</OkBadge>
												<OkBadge ok={!!decrypted.receiveVerified}>
													Receiving {decrypted.receiveVerified ? "verified" : "not verified"}
												</OkBadge>
											</>
										) : (
											<EmailStatus userIdentity={u} />
										)}
									</>
								}
								actions={
									<>
										<Button
											variant="default"
											size="xs"
											loading={sendingId === u.identities.id}
											onClick={() => testEmail(u, decrypted)}
											leftSection={<Send size={14} />}
										>
											Send a test message
											</Button>
										<ActionIcon
											variant="light"
											color="red"
											size="md"
											aria-label="Delete identity"
											title="Delete"
											onClick={() => confirmDelete(u, false)}
										>
											<Trash2 size={14} />
										</ActionIcon>
									</>
								}
							/>
						);
					})
				)}
			</KCard>
		</>
	);
}
