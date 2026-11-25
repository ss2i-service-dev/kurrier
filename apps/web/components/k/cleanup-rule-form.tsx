"use client";
// ss2i : « Nettoyage auto... » (docs/plans/nettoyage-auto-recherche.md, MT10). Formulaire d'une regle de
// nettoyage depuis une recherche, partage par les deux interfaces (a mettre dans une modale, comme les
// menus de KArchiveFor) : duree (presets ou saisie libre), apercu serveur, recapitulatif, puis creation.
// La regle envoie des fils a la Corbeille de facon permanente et repetee : « Creer la regle » reste
// desactive tant que l'apercu de la duree et de la portee affichees n'est pas revenu, et la duree libre
// refuse toute saisie <= 0 ou non numerique. Le serveur relit identite, dossier et workspace en base ;
// ce composant n'envoie que ce que l'utilisateur voit. Logique pure : lib/cleanup-form.ts.
import React, { useRef, useState } from "react";
import { Button, Loader, NativeSelect, TextInput } from "@mantine/core";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { useNouvelle } from "@/components/k/ui-context";
import { createCleanupRule, previewCleanupRule, type CleanupPreview, type CleanupRuleInput } from "@/lib/actions/cleanup-rules";
import {
	CLEANUP_UNITS,
	canCreateCleanup,
	cleanupFormPresets,
	cleanupFreeDays,
	cleanupSummary,
	durationLabel,
	previewKey,
	type CleanupUnit,
} from "@/lib/cleanup-form";
import { cleanupQueryError } from "@common/cleanup-rules";

type Props = {
	identityPublicId: string;
	mailboxSlug: string;
	mailboxName: string;
	allFolders: boolean;
	query: string;
	hasAttachment: boolean;
	onlyUnread: boolean;
	/** Fin du parcours : creation faite (le lien des reglages reste affiche) ou abandon. */
	onDone: () => void;
};

export default function KCleanupRule({ identityPublicId, mailboxSlug, mailboxName, allFolders, query, hasAttachment, onlyUnread, onDone }: Props) {
	const nouvelle = useNouvelle();
	const params = useParams<{ wPublicId?: string }>();
	const [days, setDays] = useState<number | null>(null);
	const [freeText, setFreeText] = useState("");
	const [unit, setUnit] = useState<CleanupUnit>("month");
	const [freeError, setFreeError] = useState<string | null>(null);
	const [preview, setPreview] = useState<CleanupPreview | null>(null);
	const [pKey, setPKey] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [creating, setCreating] = useState(false);
	const [created, setCreated] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Une reponse d'apercu en retard (duree changee entre-temps) est ignoree.
	const seq = useRef(0);

	const muted = nouvelle ? "text-k-ink-3" : "text-muted-foreground";
	const queryError = cleanupQueryError(query);
	const input = (d: number): CleanupRuleInput => ({ identityPublicId, mailboxSlug, allFolders, query: query.trim(), hasAttachment, onlyUnread, retentionDays: d });
	const key = days === null ? null : previewKey(input(days));
	const can = canCreateCleanup({ preview, previewKey: pKey, key, busy: loading || creating });

	// Changer la saisie libre ou l'unite rend l'apercu affiche faux pour ce que le champ dit : on l'efface,
	// avec la duree choisie, et une reponse encore en vol est ignoree.
	function resetPreview() {
		seq.current += 1;
		setDays(null);
		setPreview(null);
		setPKey(null);
		setLoading(false);
		setError(null);
		setFreeError(null);
	}

	async function choose(d: number) {
		const n = ++seq.current;
		setDays(d);
		setPreview(null);
		setPKey(null);
		setError(null);
		setLoading(true);
		try {
			const res = await previewCleanupRule(input(d));
			if (n !== seq.current) return;
			if (res.success && res.data) {
				setPreview(res.data);
				setPKey(previewKey(input(d)));
			} else {
				setError(res.error ?? "L'aperçu a échoué");
			}
		} catch (e: any) {
			if (n === seq.current) setError(e?.message ?? "L'aperçu a échoué");
		} finally {
			if (n === seq.current) setLoading(false);
		}
	}

	function applyFree() {
		const r = cleanupFreeDays(freeText, unit);
		if ("error" in r) {
			setFreeError(r.error);
			return;
		}
		setFreeError(null);
		choose(r.days);
	}

	async function create() {
		if (days === null || !canCreateCleanup({ preview, previewKey: pKey, key, busy: loading || creating })) return;
		setCreating(true);
		setError(null);
		try {
			const res = await createCleanupRule(input(days));
			if (res.success) {
				setCreated(true);
				toast.success("Règle de nettoyage créée", { position: "bottom-center" });
			} else {
				setError(res.error ?? "La création a échoué");
			}
		} catch (e: any) {
			setError(e?.message ?? "La création a échoué");
		} finally {
			setCreating(false);
		}
	}

	const settingsHref = `/w/${params?.wPublicId ?? ""}/dashboard/mail/${identityPublicId}/settings/cleanup`;

	if (created) {
		return (
			<div className="flex flex-col gap-3 text-[13px]">
				<p>La règle est créée. Elle s'applique à chaque passage du nettoyage, toutes les 15 minutes ; les premiers fils partent à la Corbeille à partir du prochain passage, par lots de 200.</p>
				<Link href={settingsHref} className="underline">
					Voir les règles de nettoyage
				</Link>
				<Button fullWidth onClick={onDone}>
					Fermer
				</Button>
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-3 text-[13px]">
			<p className={muted}>
				Envoie à la Corbeille les fils qui correspondent à cette recherche et dont le dernier message est plus ancien que la durée choisie. La règle reste active jusqu'à sa suppression.
			</p>
			{queryError && <p role="alert" className="text-red-600">{queryError}</p>}

			<div className="flex flex-col gap-2">
				<span className="font-medium">Sans nouveau message depuis…</span>
				<div className="flex flex-wrap gap-2">
					{cleanupFormPresets().map((p) => (
						<Button
							key={p.id}
							size="xs"
							variant={days === p.days ? "filled" : "default"}
							disabled={Boolean(queryError) || creating}
							onClick={() => choose(p.days)}
						>
							{p.label}
						</Button>
					))}
				</div>
				<div className="flex items-end gap-2">
					<TextInput
						aria-label="Durée libre"
						placeholder="Autre durée"
						inputMode="decimal"
						size="xs"
						w={110}
						value={freeText}
						onChange={(e) => {
							setFreeText(e.currentTarget.value);
							resetPreview();
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") applyFree();
						}}
						disabled={Boolean(queryError) || creating}
					/>
					<NativeSelect
						aria-label="Unité"
						size="xs"
						data={CLEANUP_UNITS.map((u) => ({ value: u.id, label: u.label }))}
						value={unit}
						onChange={(e) => {
							setUnit(e.currentTarget.value as CleanupUnit);
							resetPreview();
						}}
						disabled={Boolean(queryError) || creating}
					/>
					<Button size="xs" variant="default" onClick={applyFree} disabled={Boolean(queryError) || creating}>
						Calculer
					</Button>
				</div>
				{freeError && <p role="alert" className="text-red-600">{freeError}</p>}
			</div>

			{loading && (
				<div className={`flex items-center gap-2 ${muted}`} role="status">
					<Loader size={14} color="gray" />
					<span>Calcul de l'aperçu…</span>
				</div>
			)}
			{error && <p role="alert" className="text-red-600">{error}</p>}

			{preview && days !== null && pKey === key && (
				<ul className="flex list-disc flex-col gap-1 pl-5">
					{cleanupSummary({ query: query.trim(), mailboxName, allFolders, hasAttachment, onlyUnread, days, preview }).map((l) => (
						<li key={l}>{l}</li>
					))}
				</ul>
			)}

			<div className="flex gap-2">
				<Button variant="default" onClick={onDone} disabled={creating}>
					Annuler
				</Button>
				<Button fullWidth disabled={!can} loading={creating} onClick={create}>
					{days !== null && can ? `Créer la règle (${durationLabel(days)})` : "Créer la règle"}
				</Button>
			</div>
		</div>
	);
}
