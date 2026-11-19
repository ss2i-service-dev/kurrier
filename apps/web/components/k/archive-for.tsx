"use client";
// ss2i : « Archiver pour... » (archiver avec une duree de vie). A cote de chaque « Archiver »,
// qui reste inchange (et le raccourci `a` aussi : ss2i-shortcuts.js vise data-k-action="archive"
// et data-ss2i-shortcut="selection-archive", que ce bouton ne porte pas). Un menu avec les durees
// (libelle, et a droite la date qu'elle donne) puis « Choisir une date... » : date seule, aucune
// heure (l'echeance est le debut du jour, fuseau du navigateur). Hors dossier Archive : archive
// avec echeance (mailActions.archive, toast « Annuler »). Dans le dossier Archive : regle
// l'echeance des fils deja archives (setThreadExpiry), etat visible sur le bouton, toast a la fin.
import React, { useMemo, useState } from "react";
import { Button, Loader, Menu, Modal } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useDisclosure } from "@mantine/hooks";
import { CalendarClock } from "lucide-react";
import { toast } from "sonner";
import KIconButton from "@/components/k/icon-button";
import { mailActions, scheduleRefresh } from "@/components/k/mail-store";
import { setThreadExpiry } from "@/lib/actions/mailbox";
import { expiryMenuOptions, pickerDate } from "@/lib/archive-for";
import { formatExpiry } from "@common/thread-expiry";

type Props = {
	mailboxId: string;
	mailboxKind: string;
	smtp: boolean;
	/** Fils concernes, lus au clic (la selection change entre deux rendus). */
	threadIds: () => string[];
	/** Fils non lus parmi eux (compteur du dossier) ; 0 par defaut. */
	unread?: () => number;
	/** La selection contient un fil etoile : il n'expire jamais, le message le dit. */
	starred?: () => boolean;
	/** Juste avant l'archivage : vider la selection, passer au fil suivant... */
	before?: () => void;
	/** Barre de selection : bouton nu de cette classe (icone seule, comme ses voisins) au lieu d'un KIconButton. */
	bulkClassName?: string;
	size?: "sm" | "md";
};

export default function KArchiveFor({
	mailboxId,
	mailboxKind,
	smtp,
	threadIds,
	unread,
	starred,
	before,
	bulkClassName,
	size = "md",
}: Props) {
	const inArchive = mailboxKind === "archive";
	const [menuOpened, setMenuOpened] = useState(false);
	const [pickerOpened, pickerDisclosure] = useDisclosure(false);
	const [picked, setPicked] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [options, setOptions] = useState(() => expiryMenuOptions(new Date()));
	const label = inArchive ? "Durée de vie…" : "Archiver pour…";

	// Dates recalculees a l'ouverture : l'onglet reste ouvert des jours.
	const onMenuChange = (opened: boolean) => {
		if (opened) setOptions(expiryMenuOptions(new Date()));
		setMenuOpened(opened);
	};

	const tomorrow = useMemo(() => {
		const n = new Date();
		return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
	}, [pickerOpened]);

	async function apply(at: Date) {
		const ids = threadIds().map(String);
		if (!ids.length || saving) return;
		const iso = at.toISOString();
		pickerDisclosure.close();
		if (!inArchive) {
			before?.();
			mailActions.archive(ids, mailboxId, smtp, unread?.() ?? 0, iso, starred?.() ?? false);
			return;
		}
		setSaving(true);
		try {
			const res = await setThreadExpiry({ threadIds: ids, mailboxId, expiresAt: iso });
			if (!res.ok) {
				toast.error(res.reason, { position: "bottom-center" });
			} else if (res.skipped > 0) {
				toast.error(`${res.updated} sur ${ids.length} mis à jour : les fils étoilés ou déjà dans la boîte de réception n'expirent pas`, {
					position: "bottom-center",
				});
			} else {
				toast.success(`Disparaît le ${formatExpiry(at)}`, { position: "bottom-center" });
			}
			scheduleRefresh(300);
		} catch (e: any) {
			toast.error(e?.message ?? "La mise à jour a échoué", { position: "bottom-center" });
		} finally {
			setSaving(false);
		}
	}

	const icon = saving ? <Loader size={15} color="gray" /> : <CalendarClock className={bulkClassName ? "h-4 w-4" : undefined} />;
	const trigger = bulkClassName ? (
		<button type="button" aria-label={label} title={label} disabled={saving} className={bulkClassName}>
			{icon}
		</button>
	) : (
		<KIconButton size={size} label={label} disabled={saving}>
			{icon}
		</KIconButton>
	);

	return (
		<>
			<Menu opened={menuOpened} onChange={onMenuChange} position="bottom-end" withinPortal zIndex={1002} width={230}>
				<Menu.Target>{trigger}</Menu.Target>
				<Menu.Dropdown>
					<Menu.Label>{inArchive ? "Disparaît dans…" : "Archiver, puis disparaît dans…"}</Menu.Label>
					{options.map((o) => (
						<Menu.Item
							key={o.id}
							onClick={() => apply(new Date(o.iso))}
							rightSection={<span className="text-[12px] tabular-nums text-k-ink-3">{o.date}</span>}
						>
							{o.label}
						</Menu.Item>
					))}
					<Menu.Divider />
					<Menu.Item
						onClick={() => {
							setPicked(null);
							pickerDisclosure.open();
						}}
					>
						Choisir une date…
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>

			<Modal
				centered
				opened={pickerOpened}
				onClose={pickerDisclosure.close}
				title={<span className="text-[15px] font-semibold">{inArchive ? "Disparaît le…" : "Archiver, puis disparaît le…"}</span>}
				size="sm"
				zIndex={1003}
			>
				<DatePickerInput
					label="Choisir le jour"
					placeholder="JJ/MM/AAAA"
					value={picked}
					onChange={(v) => setPicked(typeof v === "string" ? v : v ? String(v) : null)}
					valueFormat="DD/MM/YYYY"
					minDate={tomorrow}
					popoverProps={{ zIndex: 1004 }}
					className="my-4"
					clearable
				/>
				<Button
					fullWidth
					disabled={!picked}
					onClick={() => {
						const at = pickerDate(picked);
						if (at) apply(at);
					}}
				>
					{inArchive ? "Appliquer" : "Archiver"}
				</Button>
			</Modal>
		</>
	);
}
