"use client";
// Sending / storage providers and SMTP accounts (modern interface). Same server
// actions and same forms as the classic interface.
import * as React from "react";
import { useMemo, useState } from "react";
import { ActionIcon, Button } from "@mantine/core";
import { modals } from "@mantine/modals";
import { toast } from "sonner";
import {
	BadgeCheck,
	BadgeMinus,
	Edit,
	ExternalLink,
	HardDrive,
	Lock,
	Mail,
	Pencil,
	Play,
	Plus,
	ServerCog,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { ProviderSpec } from "@schema";
import {
	deleteSmtpAccount,
	FetchDecryptedSecretsResult,
	FetchDecryptedSecretsResultRow,
	SyncProvidersRow,
	verifyProviderAccount,
	verifySmtpAccount,
} from "@/lib/actions/dashboard";
import { parseSecret } from "@/lib/utils";
import ProviderEditForm from "@/components/dashboard/providers/provider-edit-form";
import NewSmtpAccountForm from "@/components/dashboard/providers/new-smtp-account-form";
import { KBadge, KCard, KEmpty, KRow } from "@/components/k/platform/ui";

const PROVIDER_TEXT: Record<string, string> = {
	ses: "Send and receive through Amazon SES.",
	sendgrid: "Send messages through the SendGrid API.",
	mailgun: "Send messages through the Mailgun API.",
	postmark: "Send messages through the Postmark API.",
	s3: "Object storage for Drive files.",
};

const VERIFY_OK: Record<string, string> = {
	ses: "The SES credentials are valid and the account is reachable.",
	postmark: "The Postmark credentials are valid and the API is reachable.",
	sendgrid: "The SendGrid API key is valid and sending is enabled.",
	mailgun: "The Mailgun credentials are valid and the account is reachable.",
	s3: "The S3 credentials are valid and the account is reachable.",
};

/** Sending or storage provider with its encrypted credentials. */
export function KProviderCard({
	spec,
	userProvider,
	decryptedSecret,
	provisioned = false,
}: {
	spec: ProviderSpec;
	userProvider: SyncProvidersRow;
	decryptedSecret: FetchDecryptedSecretsResult[number];
	provisioned?: boolean;
}) {
	const values = useMemo(() => parseSecret(decryptedSecret), [decryptedSecret]);
	const [testing, setTesting] = useState(false);

	const openEdit = () => {
		const id = modals.open({
			title: `Edit ${spec.name} account`,
			size: "lg",
			children: (
				<div className="pb-2 pt-1">
					<ProviderEditForm
						spec={spec}
						onCompleted={() => modals.close(id)}
						providerId={userProvider.id}
						decryptedSecret={decryptedSecret}
					/>
				</div>
			),
		});
	};

	const verify = async () => {
		setTesting(true);
		try {
			const { data: res } = await verifyProviderAccount(userProvider.type, decryptedSecret);
			if (res.ok && (res.meta?.send || res.meta?.store)) {
				toast.success(`${userProvider.type.toUpperCase()} connection verified`, {
					description: VERIFY_OK[userProvider.type] ?? "The sending server is reachable and the credentials are valid.",
				});
			} else {
				toast.error(`${userProvider.type.toUpperCase()} verification failed`, {
					description: String(res.meta?.response ?? res.message) || "Could not connect with the credentials provided.",
				});
			}
		} catch (err: any) {
			toast.error("Verification error", {
								description: err?.message ?? "Unexpected error while testing the account.",
			});
		} finally {
			setTesting(false);
		}
	};

	const verified = provisioned ? true : !!values.verified;
	return (
		<KCard flush className="h-full">
			<div className="flex h-full flex-col gap-3 px-5 pb-4">
				<div className="flex items-start gap-3">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-k-sm bg-k-hover text-k-ink-2">
						{provisioned ? <HardDrive size={17} /> : <Mail size={17} />}
					</div>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-[15px] font-semibold tracking-tight text-k-ink">{spec.name}</h3>
							{verified ? (
								<KBadge tone="ok" icon={<BadgeCheck />}>
									Verified
								</KBadge>
							) : (
								<KBadge tone="danger" icon={<BadgeMinus />}>
									Not verified
								</KBadge>
							)}
						</div>
						<p className="mt-1 text-[13px] text-k-ink-2">
							{PROVIDER_TEXT[spec.key] ?? ""} Credentials are encrypted in the vault.
						</p>
					</div>
				</div>
				<div className="mt-auto flex flex-wrap gap-2 pt-1">
					<Button
						variant="default"
						component="a"
						size="xs"
						href={spec.docsUrl}
						target="_blank"
						rel="noreferrer"
						leftSection={<ExternalLink size={14} />}
					>
						Documentation
					</Button>
					{!provisioned && (
						<Button variant="default" size="xs" loading={testing} onClick={verify} leftSection={<Play size={14} />}>
							Verify connection
							</Button>
					)}
					{!provisioned && (
						<Button size="xs" onClick={openEdit} leftSection={<Edit size={14} />}>
							Edit
						</Button>
					)}
				</div>
			</div>
		</KCard>
	);
}

function SmtpAccountRow({ smtpSecret }: { smtpSecret: FetchDecryptedSecretsResultRow }) {
	const v = parseSecret(smtpSecret);
	const [testing, setTesting] = useState(false);

	const openEdit = () => {
		const id = modals.open({
			title: "Edit SMTP account",
			size: "lg",
			children: (
				<div className="pb-2 pt-1">
					<NewSmtpAccountForm smtpSecret={smtpSecret} onCompleted={() => modals.close(id)} />
				</div>
			),
		});
	};

	const confirmDelete = () =>
		modals.openConfirmModal({
			title: "Delete SMTP account",
			centered: true,
			children: (
				<div className="text-[13.5px] text-k-ink-2">
					Are you sure you want to delete <b className="text-k-ink">{v.label}</b>? The account will be removed and its
											secrets detached.
				</div>
			),
			labels: { confirm: "Delete", cancel: "Cancel" },
			confirmProps: { color: "red" },
			onConfirm: async () => {
				const { success } = await deleteSmtpAccount(String(smtpSecret?.linkRow?.accountId));
				if (success) toast.success("SMTP account deleted");
			},
		});

	const verify = async () => {
		setTesting(true);
		try {
			const { data: res } = await verifySmtpAccount(smtpSecret);
			if (res?.meta?.send) {
				toast.success("SMTP connection verified", {
										description: "The sending server is reachable and the credentials are valid.",
				});
			} else {
				toast.error("SMTP verification failed", {
										description: String(res?.meta?.response) || "Could not connect with the SMTP credentials provided.",
				});
			}
			if (res?.meta?.receive !== undefined) {
				if (res?.meta.receive) {
					toast.success("IMAP connection verified", {
												description: "The receiving server is reachable and the credentials are valid.",
					});
				} else {
					toast.error("IMAP verification failed", {
												description: String(res.meta?.response) || "Could not connect with the IMAP credentials provided.",
					});
				}
			}
			if (!res?.ok) {
				toast.error("SMTP verification failed", {
										description: res?.message || "Verification failed for an unknown reason.",
				});
			}
		} catch (err: any) {
			toast.error("Verification error", {
				description: err?.message ?? "Unexpected error while testing SMTP / IMAP.",
			});
		} finally {
			setTesting(false);
		}
	};

	return (
		<KRow
			icon={<ServerCog />}
			title={v.label}
			meta={
				<div className="space-y-0.5">
					<div className="flex flex-wrap items-center gap-x-3">
						<span className="inline-flex items-center gap-1">
							<Lock size={12} />
							SMTP {v.SMTP_HOST}:{v.SMTP_PORT}
						</span>
						<span className="inline-flex items-center gap-1">
							<ShieldCheck size={12} />
							{v.SMTP_SECURE === "true" ? "TLS" : "STARTTLS"}
						</span>
					</div>
					{v.IMAP_HOST && v.IMAP_PORT && (
						<div className="flex flex-wrap items-center gap-x-3">
							<span className="inline-flex items-center gap-1">
								<Lock size={12} />
								IMAP {v.IMAP_HOST}:{v.IMAP_PORT}
							</span>
							<span className="inline-flex items-center gap-1">
								<ShieldCheck size={12} />
								{v.IMAP_SECURE === "true" ? "TLS" : "STARTTLS"}
							</span>
						</div>
					)}
				</div>
			}
			badges={
				<>
					<KBadge tone={v.sendVerified ? "ok" : "danger"} icon={v.sendVerified ? <BadgeCheck /> : <BadgeMinus />}>
						Sending {v.sendVerified ? "verified" : "not verified"}
					</KBadge>
					<KBadge tone={v.receiveVerified ? "ok" : "danger"} icon={v.receiveVerified ? <BadgeCheck /> : <BadgeMinus />}>
						Receiving {v.receiveVerified ? "verified" : "not verified"}
					</KBadge>
				</>
			}
			actions={
				<>
					<Button variant="default" size="xs" loading={testing} onClick={verify} leftSection={<Play size={14} />}>
						Verify connection
					</Button>
					<ActionIcon variant="default" size="md" onClick={openEdit} aria-label="Edit account" title="Edit">
						<Pencil size={14} />
					</ActionIcon>
					<ActionIcon variant="light" color="red" size="md" onClick={confirmDelete} aria-label="Delete account" title="Delete">
						<Trash2 size={14} />
					</ActionIcon>
				</>
			}
		/>
	);
}

/** Custom SMTP / IMAP accounts. */
export function KSmtpSection({ smtpSecrets }: { smtpSecrets: FetchDecryptedSecretsResult }) {
	const openAdd = () => {
		const id = modals.open({
			title: "Add an SMTP account",
			closeOnEscape: false,
			closeOnClickOutside: false,
			size: "lg",
			children: (
				<div className="pb-2 pt-1">
					<NewSmtpAccountForm onCompleted={() => modals.close(id)} />
				</div>
			),
		});
	};
	const addBtn = (
		<Button size="xs" onClick={openAdd} leftSection={<Plus size={14} />}>
			Add an SMTP account
		</Button>
	);
	return (
		<KCard
			flush
			title="Custom SMTP"
			description="SMTP and IMAP accounts of your organization. Secrets are kept in the vault and attached to each account. Works with cPanel, Office 365 and most hosts: implicit TLS on port 465, STARTTLS on port 587. IMAP is optional and is used to receive and sync messages."
			actions={smtpSecrets?.length ? addBtn : undefined}
		>
			{!smtpSecrets?.length ? (
				<KEmpty
					icon={<ServerCog />}
					title="No SMTP accounts"
					text="Add an account to send, and receive over IMAP, from your own server."
					action={addBtn}
				/>
			) : (
				smtpSecrets.map((s) => <SmtpAccountRow key={s.metaId} smtpSecret={s} />)
			)}
		</KCard>
	);
}
