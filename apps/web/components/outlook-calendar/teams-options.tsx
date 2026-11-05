"use client";
// ss2i : options d'une reunion Teams que l'on organise, comme « Options de reunion » de Teams :
// salle d'attente, qui presente, conversation, micro et camera des participants,
// enregistrement automatique, annonce des arrivees. Lues et ecrites par Microsoft Graph
// (onlineMeetings) ; l'identifiant de la reunion est relu cote serveur depuis l'evenement.
import React, { useEffect, useState } from "react";
import { Button, Checkbox, Loader, Modal, NativeSelect } from "@mantine/core";
import { TEAMS_CHAT, TEAMS_LOBBY, TEAMS_PRESENTERS, type TeamsOptions } from "@common/outlook-graph";
import { outlookTeamsOptions, saveOutlookTeamsOptions } from "@/lib/actions/outlook-calendar";

export default function TeamsOptionsModal({
	identityPublicId,
	eventId,
	opened,
	onClose,
	onSaved,
}: {
	identityPublicId: string;
	eventId: string;
	opened: boolean;
	onClose: () => void;
	onSaved: (message: string) => void;
}) {
	const [o, setO] = useState<TeamsOptions | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		if (!opened) return;
		let alive = true;
		setO(null);
		setError(null);
		outlookTeamsOptions({ identityPublicId, id: eventId })
			.catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
			.then((res) => {
				if (!alive) return;
				if (res.ok) setO(res.options);
				else setError(res.error);
			});
		return () => {
			alive = false;
		};
	}, [opened, identityPublicId, eventId]);

	const set = (patch: Partial<TeamsOptions>) => setO((cur) => (cur ? { ...cur, ...patch } : cur));

	const save = async () => {
		if (!o) return;
		setSaving(true);
		setError(null);
		const res = await saveOutlookTeamsOptions({ identityPublicId, id: eventId, options: o }).catch((e: unknown) => ({
			ok: false as const,
			error: String((e as Error)?.message ?? e),
		}));
		setSaving(false);
		if (!res.ok) {
			setError(res.error);
			return;
		}
		onSaved("Options de la réunion Teams enregistrées");
		onClose();
	};

	return (
		<Modal opened={opened} onClose={onClose} title="Options de la réunion Teams" size="lg" zIndex={400}>
			{!o && !error && (
				<div className="flex items-center gap-2 text-sm">
					<Loader size="sm" /> Lecture dans Teams…
				</div>
			)}
			{o && (
				<div className="space-y-3">
					<NativeSelect size="sm" label="Qui peut contourner la salle d'attente ?" value={o.lobby} onChange={(e) => set({ lobby: e.currentTarget.value as TeamsOptions["lobby"] })} data={TEAMS_LOBBY} />
					<Checkbox size="sm" label="Les personnes qui appellent par téléphone contournent la salle d'attente" checked={o.dialInBypassLobby} onChange={(e) => set({ dialInBypassLobby: e.currentTarget.checked })} />
					<NativeSelect size="sm" label="Qui peut présenter ?" value={o.presenters} onChange={(e) => set({ presenters: e.currentTarget.value as TeamsOptions["presenters"] })} data={TEAMS_PRESENTERS} />
					<NativeSelect size="sm" label="Conversation de la réunion" value={o.chat} onChange={(e) => set({ chat: e.currentTarget.value as TeamsOptions["chat"] })} data={TEAMS_CHAT} />
					<Checkbox size="sm" label="Autoriser le micro des participants" checked={o.mic} onChange={(e) => set({ mic: e.currentTarget.checked })} />
					<Checkbox size="sm" label="Autoriser la caméra des participants" checked={o.camera} onChange={(e) => set({ camera: e.currentTarget.checked })} />
					<Checkbox size="sm" label="Enregistrer automatiquement" checked={o.recordAutomatically} onChange={(e) => set({ recordAutomatically: e.currentTarget.checked })} />
					<Checkbox size="sm" label="Annoncer les arrivées et les départs" checked={o.announceEntryExit} onChange={(e) => set({ announceEntryExit: e.currentTarget.checked })} />
				</div>
			)}
			{error && (
				<div className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
					{error}
				</div>
			)}
			<div className="mt-4 flex justify-end gap-2">
				<Button variant="default" size="sm" onClick={onClose}>
					Fermer
				</Button>
				{o && (
					<Button size="sm" loading={saving} onClick={() => void save()}>
						Enregistrer
					</Button>
				)}
			</div>
		</Modal>
	);
}
