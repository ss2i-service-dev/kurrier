// ss2i : vue d'ensemble de la Plateforme (nouvelle interface), memes donnees que la classique.
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
				{ icon: <Plug />, label: "Fournisseurs connectés", value: fmtNumber(s?.connectedProviders), hint: "Envoi et stockage" },
				{ icon: <Send />, label: "Identités actives", value: fmtNumber(s?.activeIdentities), hint: "Boîtes et expéditeurs" },
				{
					icon: <Mail />,
					label: "Messages stockés",
					value: fmtNumber(s?.emailsProcessedTotal),
					hint: `${fmtNumber(s?.emailsProcessed24h)} sur les dernières 24 h`,
				},
				{
					icon: <HardDrive />,
					label: "Stockage utilisé",
					value: fmtBytes(totalStorage),
					hint: s?.isStorageOverLimit ? "Limite de stockage dépassée" : "Dans la limite de l'offre",
				},
			]
		: [
				{
					icon: <Mail />,
					label: "Messages",
					value: fmtNumber(s?.emailsProcessedTotal),
					hint: `${fmtNumber(s?.emailsProcessed24h)} sur les dernières 24 h`,
				},
				{ icon: <FileText />, label: "Conversations", value: fmtNumber(s?.threadCount), hint: "Accessibles" },
				{
					icon: <Database />,
					label: "Brouillons",
					value: fmtNumber(s?.draftCount),
					hint: `${fmtNumber(s?.scheduledDraftCount)} programmés`,
				},
				{ icon: <HardDrive />, label: "Stockage des messages", value: fmtBytes(s?.rawMessageBytes), hint: "Messages accessibles" },
			];

	const steps = [
		{
			title: "Connecter un fournisseur",
			text: "Ajoutez SES, Postmark, SendGrid, Mailgun ou un compte SMTP.",
			done: Number(s?.connectedProviders || 0) > 0,
			href: `${base}/providers`,
		},
		{
			title: "Vérifier un domaine",
			text: "Ajoutez les enregistrements DNS et confirmez la propriété du domaine.",
			done: Number(s?.verifiedDomains || 0) > 0,
			href: `${base}/identities`,
		},
		{
			title: "Créer une identité",
			text: "Créez une adresse e-mail pour envoyer ou recevoir.",
			done: Number(s?.activeIdentities || 0) > 0,
			href: `${base}/identities`,
		},
		{
			title: "Créer un volume de stockage",
			text: "Ajoutez un volume Drive pour les fichiers de l'espace de travail.",
			done: Number(s?.volumeCount || 0) > 0,
			href: `${base}/storage`,
		},
	];
	const doneCount = steps.filter((x) => x.done).length;

	const storageRows: [string, string][] = [
		["Messages bruts (EML)", fmtBytes(s?.rawMessageBytes)],
		["Pièces jointes", fmtBytes(s?.attachmentBytes)],
		...(isOwner ? ([["Fichiers du Drive", fmtBytes(s?.driveStorageBytes)]] as [string, string][]) : []),
		["Total", fmtBytes(totalStorage)],
	];

	return (
		<KPage
			wide
			title={`Bienvenue dans ${workspace?.name || "Kurrier"}`}
			subtitle={
				isOwner
					? "Configuration, volume de messages et stockage de l'espace de travail."
					: "Vos messages, conversations et brouillons accessibles."
			}
			actions={
				isOwner ? (
					<div className="hidden gap-2 sm:flex">
						<KLinkButton href={`${base}/identities`}>Créer une identité</KLinkButton>
						<KLinkButton href={`${base}/providers`} primary>
							Ajouter un fournisseur
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
						title="Étapes de configuration"
						description={`${doneCount} sur ${steps.length} terminées`}
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
					title="Flux de messages"
					description={isOwner ? "Activité de l'espace de travail." : "Activité à laquelle vous avez accès."}
				>
					<KFacts
						rows={[
							["Messages au total", fmtNumber(s?.emailsProcessedTotal)],
							["Dernières 24 h", fmtNumber(s?.emailsProcessed24h)],
							["Conversations", fmtNumber(s?.threadCount)],
							["Brouillons", fmtNumber(s?.draftCount)],
							["Brouillons programmés", fmtNumber(s?.scheduledDraftCount)],
							["Pièces jointes", fmtNumber(s?.attachmentCount)],
						]}
					/>
				</KCard>
			</div>

			<div className={`grid gap-4 ${isOwner ? "md:grid-cols-2" : ""}`}>
				<KCard title="Stockage" description="Répartition de l'espace utilisé.">
					<KFacts rows={storageRows} />
				</KCard>
				{isOwner && (
					<KCard title="Configuration" description="Éléments en place dans l'espace de travail.">
						<KFacts
							rows={[
								["Fournisseurs", fmtNumber(s?.connectedProviders)],
								["Domaines vérifiés", fmtNumber(s?.verifiedDomains)],
								["Identités", fmtNumber(s?.activeIdentities)],
								["Volumes", fmtNumber(s?.volumeCount)],
								["Entrées du Drive", fmtNumber(s?.driveEntryCount)],
							]}
						/>
					</KCard>
				)}
			</div>
		</KPage>
	);
}
