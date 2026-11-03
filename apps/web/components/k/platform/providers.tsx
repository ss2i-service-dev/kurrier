"use client";
// ss2i : fournisseurs d'envoi / de stockage et comptes SMTP (nouvelle interface).
// Memes actions serveur et memes formulaires que l'interface classique.
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
	ses: "Envoi et réception via Amazon SES.",
	sendgrid: "Envoi de messages via l'API SendGrid.",
	mailgun: "Envoi de messages via l'API Mailgun.",
	postmark: "Envoi de messages via l'API Postmark.",
	s3: "Stockage d'objets pour les fichiers du Drive.",
};

const VERIFY_OK: Record<string, string> = {
	ses: "Les identifiants SES sont valides et le compte est joignable.",
	postmark: "Les identifiants Postmark sont valides et l'API est joignable.",
	sendgrid: "La clé d'API SendGrid est valide et l'envoi est activé.",
	mailgun: "Les identifiants Mailgun sont valides et le compte est joignable.",
	s3: "Les identifiants S3 sont valides et le compte est joignable.",
};

/** Fournisseur d'envoi ou de stockage avec ses identifiants chiffres. */
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
			title: `Modifier le compte ${spec.name}`,
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
				toast.success(`Connexion ${userProvider.type.toUpperCase()} vérifiée`, {
					description: VERIFY_OK[userProvider.type] ?? "Le serveur d'envoi est joignable et les identifiants sont valides.",
				});
			} else {
				toast.error(`Échec de la vérification ${userProvider.type.toUpperCase()}`, {
					description: String(res.meta?.response ?? res.message) || "Connexion impossible avec les identifiants fournis.",
				});
			}
		} catch (err: any) {
			toast.error("Erreur de vérification", {
				description: err?.message ?? "Erreur inattendue pendant le test du compte.",
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
									Vérifié
								</KBadge>
							) : (
								<KBadge tone="danger" icon={<BadgeMinus />}>
									Non vérifié
								</KBadge>
							)}
						</div>
						<p className="mt-1 text-[13px] text-k-ink-2">
							{PROVIDER_TEXT[spec.key] ?? ""} Les identifiants sont chiffrés dans le coffre.
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
							Vérifier la connexion
						</Button>
					)}
					{!provisioned && (
						<Button size="xs" onClick={openEdit} leftSection={<Edit size={14} />}>
							Modifier
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
			title: "Modifier le compte SMTP",
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
			title: "Supprimer le compte SMTP",
			centered: true,
			children: (
				<div className="text-[13.5px] text-k-ink-2">
					Voulez-vous vraiment supprimer <b className="text-k-ink">{v.label}</b> ? Le compte sera retiré et ses secrets
					dissociés.
				</div>
			),
			labels: { confirm: "Supprimer", cancel: "Annuler" },
			confirmProps: { color: "red" },
			onConfirm: async () => {
				const { success } = await deleteSmtpAccount(String(smtpSecret?.linkRow?.accountId));
				if (success) toast.success("Compte SMTP supprimé");
			},
		});

	const verify = async () => {
		setTesting(true);
		try {
			const { data: res } = await verifySmtpAccount(smtpSecret);
			if (res?.meta?.send) {
				toast.success("Connexion SMTP vérifiée", {
					description: "Le serveur d'envoi est joignable et les identifiants sont valides.",
				});
			} else {
				toast.error("Échec de la vérification SMTP", {
					description: String(res?.meta?.response) || "Connexion impossible avec les identifiants SMTP fournis.",
				});
			}
			if (res?.meta?.receive !== undefined) {
				if (res?.meta.receive) {
					toast.success("Connexion IMAP vérifiée", {
						description: "Le serveur de réception est joignable et les identifiants sont valides.",
					});
				} else {
					toast.error("Échec de la vérification IMAP", {
						description: String(res.meta?.response) || "Connexion impossible avec les identifiants IMAP fournis.",
					});
				}
			}
			if (!res?.ok) {
				toast.error("Échec de la vérification SMTP", {
					description: res?.message || "La vérification a échoué pour une raison inconnue.",
				});
			}
		} catch (err: any) {
			toast.error("Erreur de vérification", {
				description: err?.message ?? "Erreur inattendue pendant le test SMTP / IMAP.",
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
						Envoi {v.sendVerified ? "vérifié" : "non vérifié"}
					</KBadge>
					<KBadge tone={v.receiveVerified ? "ok" : "danger"} icon={v.receiveVerified ? <BadgeCheck /> : <BadgeMinus />}>
						Réception {v.receiveVerified ? "vérifiée" : "non vérifiée"}
					</KBadge>
				</>
			}
			actions={
				<>
					<Button variant="default" size="xs" loading={testing} onClick={verify} leftSection={<Play size={14} />}>
						Vérifier la connexion
					</Button>
					<ActionIcon variant="default" size="md" onClick={openEdit} aria-label="Modifier le compte" title="Modifier">
						<Pencil size={14} />
					</ActionIcon>
					<ActionIcon variant="light" color="red" size="md" onClick={confirmDelete} aria-label="Supprimer le compte" title="Supprimer">
						<Trash2 size={14} />
					</ActionIcon>
				</>
			}
		/>
	);
}

/** Comptes SMTP / IMAP personnalises. */
export function KSmtpSection({ smtpSecrets }: { smtpSecrets: FetchDecryptedSecretsResult }) {
	const openAdd = () => {
		const id = modals.open({
			title: "Ajouter un compte SMTP",
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
			Ajouter un compte SMTP
		</Button>
	);
	return (
		<KCard
			flush
			title="SMTP personnalisé"
			description="Comptes SMTP et IMAP de votre organisation. Les secrets sont conservés dans le coffre et rattachés à chaque compte. Compatible cPanel, Office 365 et la plupart des hébergeurs : TLS implicite sur le port 465, STARTTLS sur le port 587. L'IMAP est facultatif et sert à recevoir et synchroniser les messages."
			actions={smtpSecrets?.length ? addBtn : undefined}
		>
			{!smtpSecrets?.length ? (
				<KEmpty
					icon={<ServerCog />}
					title="Aucun compte SMTP"
					text="Ajoutez un compte pour envoyer, et recevoir via IMAP, depuis votre propre serveur."
					action={addBtn}
				/>
			) : (
				smtpSecrets.map((s) => <SmtpAccountRow key={s.metaId} smtpSecret={s} />)
			)}
		</KCard>
	);
}
