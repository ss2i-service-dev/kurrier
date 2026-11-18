"use client";
// SS2i : Parametres > Ouverture des mails (nouvelle interface). Onglets internes
// du volet lecture, desactives par defaut, et geste qui en ouvre un. Chaque
// changement est enregistre aussitot (lib/actions/open-prefs.ts) et applique
// sans recharger (components/k/reader-tabs.ts).
import React, { useRef, useState } from "react";
import { Radio, Switch } from "@mantine/core";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { saveOpenPrefs } from "@/lib/actions/open-prefs";
import { setOpenPrefsLocal } from "@/components/k/reader-tabs";
import type { OpenGesture, OpenPrefs } from "@/components/k/open-prefs";

export default function SettingsOpen({ initial }: { initial: OpenPrefs }) {
	const [prefs, setPrefs] = useState<OpenPrefs>(initial);
	const saving = useRef(0);

	const commit = (next: OpenPrefs) => {
		const previous = prefs;
		setPrefs(next);
		setOpenPrefsLocal(next);
		const ticket = ++saving.current;
		saveOpenPrefs(next)
			.then((r) => {
				if (ticket !== saving.current) return;
				if (!r?.success) throw new Error(r?.error);
			})
			.catch(() => {
				if (ticket !== saving.current) return;
				setPrefs(previous);
				setOpenPrefsLocal(previous);
				toast.error("Impossible d'enregistrer le réglage");
			});
	};

	const muted = "text-[12.5px] leading-relaxed text-k-ink-3";

	return (
		<SectionCard
			title="Ouverture des mails"
			description="Ouvrez plusieurs mails à la fois dans des onglets, en haut du volet de lecture. Le clic molette et Ctrl+clic sur un mail l'ouvrent toujours dans un nouvel onglet du navigateur, sauf si vous leur confiez les onglets ci-dessous."
			footer={<span className={muted}>Enregistré sur votre compte, sur tous vos postes. Les onglets ouverts restent sur ce poste.</span>}
		>
			<Switch
				label="Activer les onglets de lecture"
				checked={prefs.tabs}
				onChange={(e) => commit({ ...prefs, tabs: e.currentTarget.checked })}
			/>

			<div className={`mt-5 ${prefs.tabs ? "" : "pointer-events-none opacity-50"}`} aria-disabled={!prefs.tabs}>
				<Radio.Group
					label="Ouvrir un mail dans un onglet avec"
					value={prefs.gesture}
					onChange={(v) => commit({ ...prefs, gesture: v as OpenGesture })}
				>
					<div className="mt-2 space-y-3">
						<div>
							<Radio value="click" label="Le clic" disabled={!prefs.tabs} />
							<p className={`ml-7 mt-0.5 ${muted}`}>
								Chaque mail cliqué s'ajoute aux onglets. Le clic molette ouvre un onglet du navigateur.
							</p>
						</div>
						<div>
							<Radio value="middle" label="Le clic molette" disabled={!prefs.tabs} />
							<p className={`ml-7 mt-0.5 ${muted}`}>
								Le clic molette ajoute le mail aux onglets, en arrière-plan. Le clic ouvre un seul mail, à la place de l'onglet affiché.
							</p>
						</div>
					</div>
				</Radio.Group>
			</div>
		</SectionCard>
	);
}
