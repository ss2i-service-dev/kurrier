"use client";
// ss2i : identites (domaines et adresses) de la nouvelle interface. Memes actions
// serveur et memes formulaires d'ajout que l'interface classique.
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

const STATUS_FR: Record<IdentityStatus, { label: string; note: string }> = {
	unverified: { label: "Non vérifié", note: "La vérification n'a pas encore été lancée." },
	pending: {
		label: "DNS non configuré",
		note: "Ajoutez les enregistrements DNS chez votre hébergeur DNS pour poursuivre la vérification.",
	},
	verified: { label: "Vérifié", note: "Cette identité est entièrement vérifiée et prête à l'emploi." },
	failed: {
		label: "Échec de la vérification",
		note: "Vérifiez vos enregistrements DNS ou relancez la vérification.",
	},
};

function OkBadge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
	return (
		<KBadge tone={ok ? "ok" : "danger"} icon={ok ? <BadgeCheck /> : <BadgeMinus />}>
			{children}
		</KBadge>
	);
}

/** Statut entrant / sortant d'une adresse rattachee a un domaine. */
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
			<OkBadge ok>Envoi vérifié</OkBadge>
			<OkBadge ok={incoming}>Réception {incoming ? "vérifiée" : "non vérifiée"}</OkBadge>
		</>
	);
}

/** Rattachement de l'identite a l'espace de travail (defaut, partage, attribuee). */
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
					Par défaut
				</KBadge>
			) : (
				<Tooltip label={userEmail ?? "Non attribuée"} withArrow>
					<span>
						<KBadge>Attribuée à {userIdentity.displayName}</KBadge>
					</span>
				</Tooltip>
			)}
			{userIdentity.sharedWithWorkspace && (
				<Tooltip label="Les identités par défaut sont partagées avec tous les membres de l'espace de travail" withArrow>
					<span>
						<KBadge tone="accent" icon={<Repeat2 />}>
							Partagée avec l'espace de travail
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
					<Tooltip label={copied ? "Copié" : "Copier"} withArrow>
						<ActionIcon variant="subtle" color={copied ? "teal" : "gray"} size="sm" onClick={copy} aria-label="Copier">
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
		if (res.success) toast.success("Message de test envoyé", { description: res.message });
		else toast.error("Échec de l'envoi du message de test", { description: res.message });
		setSendingId(null);
	};

	const openAddEmail = () => {
		const id = modals.open({
			title: "Ajouter une adresse e-mail",
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
			title: "Ajouter un domaine",
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

	// Suppression avec fenetre de progression puis de resultat (domaine ou adresse).
	const runDelete = async (
		value: string,
		doDelete: () => Promise<{ success?: boolean; message?: string }>,
		okToast: string,
		koToast: string,
	) => {
		const modalId = modals.open({
			title: "Suppression en cours",
			centered: true,
			closeOnEscape: false,
			closeOnClickOutside: false,
			withCloseButton: false,
			children: (
				<div className="space-y-4 pb-2">
					<p className="text-[13.5px] text-k-ink-2">
						Suppression de <b className="text-k-ink">{value}</b>. Cela peut prendre un moment.
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
			title: ok ? "Identité supprimée" : "Échec de la suppression",
			closeOnEscape: true,
			closeOnClickOutside: true,
			withCloseButton: true,
			children: (
				<div className="space-y-4 pb-2">
					<p className={`text-[13.5px] ${ok ? "text-k-ink-2" : "text-k-danger"}`}>
						{ok ? (
							<>
								<b className="text-k-ink">{value}</b> a bien été supprimée.
							</>
						) : (
							(res.message ?? "La suppression a échoué.")
						)}
					</p>
					<div className="flex justify-center py-1">
						{ok ? <CheckCircle className="h-7 w-7 text-emerald-600" /> : <XCircle className="h-7 w-7 text-k-danger" />}
					</div>
					<Button fullWidth onClick={() => modals.close(modalId)}>
						Fermer
					</Button>
				</div>
			),
		});
	};

	const confirmDelete = (u: FetchUserIdentitiesResult[number], domain: boolean) =>
		modals.openConfirmModal({
			title: domain ? "Supprimer le domaine" : "Supprimer l'identité",
			centered: true,
			children: (
				<div className="text-[13.5px] text-k-ink-2">
					Voulez-vous vraiment supprimer <b className="text-k-ink">{u.identities.value}</b> ? Elle sera retirée
					définitivement et ses secrets dissociés.
				</div>
			),
			labels: { confirm: "Supprimer", cancel: "Annuler" },
			confirmProps: { color: "red" },
			onConfirm: () => {
				if (domain) {
					const providerAccount = providerAccounts.find((a) => a.linkRow.providerId === u.identities.providerId);
					return runDelete(
						u.identities.value,
						() => deleteDomainIdentity(u, providerAccount) as any,
						"Domaine supprimé",
						"Échec de la suppression du domaine",
					);
				}
				return runDelete(
					u.identities.value,
					() => deleteEmailIdentity(u) as any,
					"Identité supprimée",
					"Échec de la suppression de l'identité",
				);
			},
		});

	const openDns = (u: FetchUserIdentitiesResult[number]) =>
		modals.open({
			title: (
				<span>
					Enregistrements DNS de <b>{u.identities.value}</b>
				</span>
			),
			closeOnEscape: false,
			closeOnClickOutside: false,
			size: "lg",
			children: (
				<div className="space-y-2.5 pb-2">
					<p className="text-[13px] text-k-ink-2">
						Ajoutez ces enregistrements chez votre hébergeur DNS, puis relancez la vérification. La propagation peut
						prendre un peu de temps.
					</p>
					{u.identities.dnsRecords?.map((record: DnsRecord, i: number) => (
						<div key={i} className="space-y-1.5 rounded-k border border-k-line bg-k-surface-2 p-3">
							<div className="flex items-center justify-between">
								<KBadge tone="accent">{record.type}</KBadge>
								{record.ttl && <span className="text-[12px] text-k-ink-3">TTL : {record.ttl}</span>}
							</div>
							<CopyField label="Nom" value={record?.name ? record.name : u.identities.value} />
							<CopyField label="Valeur" value={record.value} />
							{record.priority && <div className="text-[12.5px] text-k-ink-3">Priorité : {record.priority || "10"}</div>}
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
			toast.success("Domaine vérifié");
		} else {
			toast.error("Échec de la vérification du domaine", {
				description:
					"Vérifiez vos enregistrements DNS. Si vous venez de les ajouter, la propagation peut prendre un peu de temps.",
			});
		}
		setVerifyingId(null);
	};

	return (
		<>
			<KCard
				flush
				title="Domaines"
				description="Domaines d'envoi et de réception, vérifiés par DNS auprès de votre fournisseur."
				actions={
					<Button size="xs" onClick={openAddDomain} leftSection={<Plus size={14} />}>
						Ajouter un domaine
					</Button>
				}
			>
				{domains.length === 0 ? (
					<KEmpty icon={<Globe />} title="Aucun domaine" text="Ajoutez votre premier domaine pour commencer." />
				) : (
					domains.map((u) => {
						const status = (u.identities.status as IdentityStatus) in STATUS_FR ? (u.identities.status as IdentityStatus) : "unverified";
						const meta = STATUS_FR[status];
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
												<KBadge icon={<ArrowUpFromLine />}>Envoi</KBadge>
												{u.identities.incomingDomain && <KBadge icon={<ArrowDownFromLine />}>Réception</KBadge>}
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
											Vérifier
										</Button>
										<Button variant="default" size="xs" onClick={() => openDns(u)} leftSection={<Eye size={14} />}>
											Enregistrements DNS
										</Button>
										<ActionIcon
											variant="light"
											color="red"
											size="md"
											aria-label="Supprimer le domaine"
											title="Supprimer"
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
				title="Adresses e-mail"
				description="Adresses utilisées pour envoyer et recevoir. Chacune dépend d'un fournisseur ou d'un compte SMTP."
				actions={
					<Button size="xs" onClick={openAddEmail} leftSection={<Plus size={14} />}>
						Ajouter une adresse
					</Button>
				}
			>
				{emails.length === 0 ? (
					<KEmpty icon={<Mail />} title="Aucune adresse e-mail" text="Ajoutez votre première adresse pour commencer." />
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
								meta={<span className="text-[11.5px]">ID : {u.identities.id}</span>}
								badges={
									<>
										<DefaultBadges
											workspace={workspace}
											userIdentity={u.identities}
											workspaceUserIdentities={workspaceUserIdentities}
										/>
										{providerType && PROVIDER_CONFIG[providerType as keyof typeof PROVIDER_CONFIG] && (
											<KBadge>{providerType === "smtp" ? "SMTP personnalisé" : PROVIDER_CONFIG[providerType as keyof typeof PROVIDER_CONFIG].name}</KBadge>
										)}
										{u.smtp_accounts ? (
											<>
												<OkBadge ok={!!decrypted.sendVerified}>
													Envoi {decrypted.sendVerified ? "vérifié" : "non vérifié"}
												</OkBadge>
												<OkBadge ok={!!decrypted.receiveVerified}>
													Réception {decrypted.receiveVerified ? "vérifiée" : "non vérifiée"}
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
											Envoyer un message de test
										</Button>
										<ActionIcon
											variant="light"
											color="red"
											size="md"
											aria-label="Supprimer l'identité"
											title="Supprimer"
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
