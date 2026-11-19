// ss2i : « Archiver pour... » (archiver avec une duree de vie), partie pure du menu : options,
// date choisie, message affiche. Date seule, aucune heure : l'echeance est le debut du jour
// (fuseau du navigateur). Cf. apps/web/test/archive-expiry.ts.
import { EXPIRY_PRESETS, expiryFromPreset, formatExpiry, type ExpiryPresetId } from "../../../packages/common/src/thread-expiry";

export type ExpiryMenuOption = { id: ExpiryPresetId; label: string; date: string; iso: string };

// Les 5 durees avec la date qu'elles donnent aujourd'hui (JJ/MM/AAAA), affichee a droite du libelle.
export function expiryMenuOptions(now: Date): ExpiryMenuOption[] {
	return EXPIRY_PRESETS.map((p) => {
		const at = expiryFromPreset(p.id, now);
		return { id: p.id, label: p.label, date: formatExpiry(at), iso: at.toISOString() };
	});
}

// DatePickerInput de Mantine 8 rend « AAAA-MM-JJ » (une Date dans les versions precedentes) :
// toujours le debut de ce jour en heure locale, jamais minuit UTC (la veille a l'est de Greenwich).
export function pickerDate(value: string | Date | null | undefined): Date | null {
	if (!value) return null;
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate());
	}
	const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
	if (!m) return null;
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Message du toast. Un fil etoile n'expire jamais (trigger ss2i_mbth_expiry_guard) : on le dit
// plutot que d'afficher une date qui ne tiendra pas.
export function archivedMessage({ count, expiresAt, starred }: { count: number; expiresAt: Date | null; starred: boolean }): string {
	const many = count > 1;
	const base = many ? `${count} fils archivés` : "Archivé";
	if (!expiresAt) return base;
	if (starred) return `${base}. Les fils étoilés n'expirent pas.`;
	return `${base}, ${many ? "disparaissent" : "disparaît"} le ${formatExpiry(expiresAt)}`;
}

// Genre (inbox, archive, trash...) du dossier actif parmi les dossiers des identites ; vide si
// inconnu. L'interface classique n'a que l'id du dossier dans la barre du mail ouvert.
export function mailboxKindOf(
	identityMailboxes: readonly { mailboxes?: readonly { id: string; kind: string }[] | null }[] | null | undefined,
	mailboxId: string,
): string {
	for (const im of identityMailboxes ?? []) {
		const box = (im?.mailboxes ?? []).find((m) => m && String(m.id) === String(mailboxId));
		if (box) return String(box.kind);
	}
	return "";
}
