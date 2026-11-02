"use client";
import { useState, useTransition } from "react";
import { Switch } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { setRfcStyleEnabled } from "@/lib/actions/rfc-style";

// ss2i : interrupteur du style RFC a l'envoi (option par utilisateur, memorisee cote
// serveur, lue par le worker a l'assemblage du message).
function SettingsComposeStyle({ enabled: initial }: { enabled: boolean }) {
	const [enabled, setEnabled] = useState(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();

	const onChange = (next: boolean) => {
		setEnabled(next);
		startTransition(async () => {
			const r = await setRfcStyleEnabled(next);
			if (r?.success === false) {
				setEnabled(!next);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(next ? "RFC composing style enabled." : "RFC composing style disabled.");
			router.refresh();
		});
	};

	return (
		<SectionCard title="Composing" description="How your replies and signature are laid out when sending.">
			<Switch
				label="Reply below quoted text and use '-- ' signature separator (RFC 3676 / netiquette)"
				description="Your reply goes under the quoted message (quoted lines prefixed with '> ' in plain text) and the signature comes last, after a line made of two dashes and a space. Off: reply above, signature between your text and the quote, as in Outlook and Gmail."
				checked={enabled}
				disabled={pending}
				onChange={(e) => onChange(e.currentTarget.checked)}
			/>
		</SectionCard>
	);
}

export default SettingsComposeStyle;
