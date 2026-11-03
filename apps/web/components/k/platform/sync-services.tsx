"use client";
// ss2i : services de synchronisation CalDAV / CardDAV (nouvelle interface).
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
			toast.error(`Rien à copier pour ${label}`);
			return;
		}
		navigator.clipboard.writeText(value);
		toast.success(`${label} copié`);
	};
	const base = baseDavUrl?.replace(/\/+$/, "") || "";
	const userRoot = `${base.replace("https://", "")}`;
	const rows = [
		{ label: "CalDAV (agenda)", url: userRoot },
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
				title="Identifiants DAV"
				description="Utilisés par vos applications d'agenda et de contacts. Ils sont distincts de votre identifiant Kurrier."
			>
				<div className="grid gap-5 md:grid-cols-2">
					<div className="space-y-1.5">
						<TextInput
							label="Nom d'utilisateur DAV"
							value={username}
							readOnly
							classNames={{ input: "font-mono !text-xs" }}
							rightSection={copyBtn(username, "Nom d'utilisateur DAV", "Copier le nom d'utilisateur")}
						/>
						<p className="text-[12px] text-k-ink-3">À saisir comme nom de compte dans vos applications CalDAV / CardDAV.</p>
					</div>
					<div className="space-y-1.5">
						<TextInput
							label="Mot de passe DAV"
							value={password ?? ""}
							readOnly
							placeholder="Générez un mot de passe pour l'afficher ici."
							classNames={{ input: "font-mono !text-xs" }}
							rightSection={copyBtn(String(password ?? ""), "Mot de passe DAV", "Copier le mot de passe")}
						/>
						<p className="text-[12px] text-k-ink-3">
							Le mot de passe créé ou renouvelé s'affiche ici pour que vous puissiez le copier sur vos appareils.
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
								{password ? "Régénérer le mot de passe" : "Générer un mot de passe"}
							</Button>
						</div>
					</div>
				</div>
			</KCard>

			<KCard
				flush
				title="URL de connexion"
				description="À utiliser pour ajouter un compte CalDAV ou CardDAV sur vos appareils. La plupart des applications acceptent l'URL complète ou les points d'accès /.well-known."
			>
				<div className="divide-y divide-k-line border-t border-k-line">
					{rows.map((row) => (
						<div key={row.label} className="flex items-center justify-between gap-3 px-5 py-3">
							<div className="min-w-0">
								<div className="text-[13px] font-medium text-k-ink">{row.label}</div>
								<div className="mt-0.5 break-all font-mono text-[12px] text-k-ink-2">{row.url}</div>
							</div>
							{copyBtn(row.url, `URL ${row.label}`, "Copier l'URL")}
						</div>
					))}
				</div>
			</KCard>

			<KCard title="Utilisation">
				<ul className="list-disc space-y-1.5 pl-4 text-[13px] text-k-ink-2">
					<li>Si l'on vous demande un serveur ou une URL de compte, collez l'URL CalDAV ou CardDAV correspondante.</li>
					<li>Saisissez le nom d'utilisateur et le mot de passe DAV lorsque l'appareil demande une connexion.</li>
					<li>Si la synchronisation échoue après un changement de mot de passe, mettez-le à jour sur chaque appareil.</li>
				</ul>
			</KCard>
		</>
	);
}
