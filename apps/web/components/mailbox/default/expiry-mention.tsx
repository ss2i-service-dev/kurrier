// ss2i : interface classique, mention orange « Disparaît le JJ/MM/AAAA » d'un fil archive avec une
// duree de vie (meme texte que thread-row.tsx de la nouvelle interface ; couleurs Tailwind
// standard, les jetons --k-* n'existent pas en classique). Rien sans echeance.
import React from "react";
import { formatExpiry } from "@common/thread-expiry";

export default function ExpiryMention({ expiresAt }: { expiresAt: Date | string | null | undefined }) {
	if (!expiresAt) return null;
	const at = new Date(expiresAt);
	return (
		<span
			className="whitespace-nowrap text-xs font-normal tabular-nums text-orange-600 dark:text-orange-400"
			title={`Ce fil ira à la Corbeille le ${formatExpiry(at)}`}
		>
			Disparaît le {formatExpiry(at)}
		</span>
	);
}
