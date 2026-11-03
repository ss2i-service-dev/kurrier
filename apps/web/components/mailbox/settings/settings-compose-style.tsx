"use client";
import { useState, useTransition } from "react";
import { Switch } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { setRfcStyleEnabled } from "@/lib/actions/rfc-style";
import { useK } from "@/components/k/ui-context";

// ss2i : interrupteur du style RFC a l'envoi (option par utilisateur, memorisee cote
// serveur, lue par le worker a l'assemblage du message).
function SettingsComposeStyle({ enabled: initial }: { enabled: boolean }) {
	const [enabled, setEnabled] = useState(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();
	const k = useK();

	const onChange = (next: boolean) => {
		setEnabled(next);
		startTransition(async () => {
			const r = await setRfcStyleEnabled(next);
			if (r?.success === false) {
				setEnabled(!next);
				toast.error(r.error ?? k("Could not save the preference", "Impossible d'enregistrer la préférence"));
				return;
			}
			toast.success(
				next
					? k("RFC composing style enabled.", "Style de rédaction RFC activé.")
					: k("RFC composing style disabled.", "Style de rédaction RFC désactivé."),
			);
			router.refresh();
		});
	};

	return (
		<SectionCard
			title={k("Composing", "Rédaction")}
			description={k("How your replies and signature are laid out when sending.", "Placement de vos réponses et de la signature à l'envoi.")}
		>
			<Switch
				label={k(
					"Reply below quoted text and use '-- ' signature separator (RFC 3676 / netiquette)",
					"Répondre sous le texte cité et séparer la signature par « -- » (RFC 3676 / nétiquette)",
				)}
				description={k(
					"Your reply goes under the quoted message (quoted lines prefixed with '> ' in plain text) and the signature comes last, after a line made of two dashes and a space. Off: reply above, signature between your text and the quote, as in Outlook and Gmail.",
					"Votre réponse se place sous le message cité (lignes citées préfixées par « > » en texte brut) et la signature vient en dernier, après une ligne composée de deux tirets et d'une espace. Désactivé : réponse au-dessus, signature entre votre texte et la citation, comme dans Outlook et Gmail.",
				)}
				checked={enabled}
				disabled={pending}
				onChange={(e) => onChange(e.currentTarget.checked)}
			/>
		</SectionCard>
	);
}

export default SettingsComposeStyle;
