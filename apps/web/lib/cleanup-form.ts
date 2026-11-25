// ss2i : formulaire « Nettoyage auto... » (docs/plans/nettoyage-auto-recherche.md, MT10), partie pure :
// durees, saisie libre, garde de creation, recapitulatif. Cf. apps/web/test/cleanup-form.ts.
import {
	CLEANUP_BATCH,
	CLEANUP_MAX_DAYS,
	CLEANUP_MIN_DAYS,
	CLEANUP_PRESETS,
	cleanupDaysFromFree,
} from "../../../packages/common/src/cleanup-rules";
import type { CleanupPreview, CleanupRuleInput } from "./actions/cleanup-rules";

export type CleanupUnit = "day" | "week" | "month" | "year";

export const CLEANUP_UNITS: { id: CleanupUnit; label: string }[] = [
	{ id: "day", label: "jours" },
	{ id: "week", label: "semaines" },
	{ id: "month", label: "mois" },
	{ id: "year", label: "ans" },
];

// Les six durees proposees (CLEANUP_PRESETS), dans l'ordre du menu.
export function cleanupFormPresets() {
	return CLEANUP_PRESETS.map((p) => ({ id: p.id, days: p.days, label: p.label }));
}

// Libelle de la portee « tous les dossiers » d'une regle (recapitulatif et page des reglages) : les dossiers
// nettoyables sont CLEANUP_ALLOWED_KINDS, pas la Corbeille ni le Spam.
export const CLEANUP_ALL_FOLDERS_LABEL = "Tous les dossiers (réception, archives et vos dossiers)";

// Jours par unite : meme table que cleanupDaysFromFree, qui borne au lieu de refuser ; ici l'arrondi hors
// plage est refuse, sans quoi « 99 ans » deviendrait en silence 10 ans.
const DAYS_PER_UNIT: Record<CleanupUnit, number> = { day: 1, week: 7, month: 30, year: 365 };

// Duree saisie librement : chiffres, avec une virgule ou un point decimal au plus ; rien d'autre (pas
// d'exposant, de signe ni d'espace interne). L'arrondi en jours doit tomber dans 1..3650, sinon refus :
// jamais une duree bornee ou par defaut pour une regle qui envoie des fils a la Corbeille.
export function cleanupFreeDays(raw: string, unit: CleanupUnit): { days: number } | { error: string } {
	const text = String(raw ?? "").trim();
	if (!text) return { error: "Saisir une durée." };
	if (!/^\d+([.,]\d+)?$/.test(text)) return { error: "La durée doit être un nombre positif, par exemple 6 ou 1,5." };
	const n = Number(text.replace(",", "."));
	if (n === 0) return { error: "La durée doit être supérieure à zéro." };
	const range = { error: `La durée va de ${CLEANUP_MIN_DAYS} à ${CLEANUP_MAX_DAYS} jours.` };
	const rounded = Math.round(n * DAYS_PER_UNIT[unit]);
	if (!Number.isFinite(rounded) || rounded < CLEANUP_MIN_DAYS || rounded > CLEANUP_MAX_DAYS) return range;
	const days = cleanupDaysFromFree(n, unit);
	return days === null ? range : { days };
}

export function durationLabel(days: number): string {
	const preset = CLEANUP_PRESETS.find((p) => p.days === days);
	if (preset) return preset.label;
	return `${days} ${days === 1 ? "jour" : "jours"}`;
}

// Identite de ce que l'apercu a compte : tout ce qui change le resultat (duree, portee, texte, filtres).
export function previewKey(input: CleanupRuleInput): string {
	return JSON.stringify([
		input.identityPublicId,
		input.mailboxSlug,
		input.allFolders,
		input.query,
		input.hasAttachment,
		input.onlyUnread,
		input.retentionDays,
	]);
}

// Creation permise seulement si l'apercu reussi est celui de la duree et de la portee affichees
// (`key` null : aucune duree valide choisie).
export function canCreateCleanup(s: { preview: CleanupPreview | null; previewKey: string | null; key: string | null; busy: boolean }): boolean {
	return Boolean(s.preview) && s.key !== null && s.previewKey === s.key && !s.busy;
}

const NBSP = " ";
function count(n: number): string {
	return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

// Lignes du recapitulatif affiche avant confirmation. Le compte est celui de la recherche stricte (le
// matcher du tick), plus petit que la liste de la recherche qui tolere les fautes : on l'ecrit.
export function cleanupSummary(s: {
	query: string;
	mailboxName: string;
	allFolders: boolean;
	hasAttachment: boolean;
	onlyUnread: boolean;
	days: number;
	preview: CleanupPreview;
}): string[] {
	const { preview } = s;
	const lines = [`Texte cherché : « ${s.query} »`, s.allFolders ? `Dossiers : ${CLEANUP_ALL_FOLDERS_LABEL}` : `Dossier : ${s.mailboxName}`];
	const filters = [s.hasAttachment ? "avec pièce jointe" : "", s.onlyUnread ? "non lus" : ""].filter(Boolean);
	if (filters.length) lines.push(`Filtres : ${filters.join(", ")}`);
	const m = preview.matching;
	lines.push(
		m === 0
			? "Aucun fil ne correspond exactement (sans tolérance aux fautes de frappe)."
			: `${count(m)} ${m === 1 ? "fil correspond" : "fils correspondent"} exactement (sans tolérance aux fautes de frappe).`,
	);
	const d = preview.dueNow;
	// Le tick passe toutes les 15 minutes et ne prend que CLEANUP_BATCH fils par regle : jamais « dans le quart d'heure ».
	const pace = `à partir du prochain passage, par lots de ${CLEANUP_BATCH} toutes les 15 minutes`;
	if (preview.truncated) lines.push(`Plus de ${count(d)} fils partent à la Corbeille ${pace}.`);
	else if (d === 0) lines.push("Aucun fil ne part à la Corbeille pour l'instant.");
	else lines.push(`${count(d)} ${d === 1 ? "fil part" : "fils partent"} à la Corbeille ${pace}.`);
	lines.push(`Ensuite, chaque fil sans nouveau message depuis ${durationLabel(s.days)} part à la Corbeille.`);
	lines.push("Les fils étoilés ne sont jamais concernés.");
	lines.push("La Corbeille se vide au bout de 30 jours.");
	return lines;
}
