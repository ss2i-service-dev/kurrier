"use client";
import { useState, useTransition } from "react";
import { Select, Switch } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { setRfcStyleEnabled } from "@/lib/actions/rfc-style";
import { setUndoSendSeconds } from "@/lib/actions/undo-send";


// Switch for the RFC composing style on send (per-user option, stored server-side,
// read by the worker when it assembles the message).
function SettingsComposeStyle({ enabled: initial, undoSeconds: initialUndo = 30 }: { enabled: boolean; undoSeconds?: number }) {
	const [undoSeconds, setUndo] = useState(initialUndo);
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
			toast.success(
				next
					? "RFC composing style enabled."
					: "RFC composing style disabled.",
			);
			router.refresh();
		});
	};

	// How long a send can be cancelled (0 = send immediately).
	const onUndoChange = (value: string | null) => {
		if (value == null) return;
		const next = Number(value);
		const previous = undoSeconds;
		setUndo(next);
		void setUndoSendSeconds(next).then((r) => {
			if (r?.success === false) {
				setUndo(previous);
				toast.error("Could not save the preference");
				return;
			}
			toast.success("Undo send delay saved.");
		});
	};
	const undoChoices = [
		{ value: "0", label: "Off (send immediately)" },
		...[5, 10, 20, 30, 60].map((n) => ({ value: String(n), label: `${n} seconds` })),
	];

	return (
		<SectionCard
			title="Composing"
			description="How your replies and signature are laid out when sending, and how long you can undo a send."
		>
			<Switch
				label="Reply below quoted text and use '-- ' signature separator (RFC 3676 / netiquette)"
				description="Your reply goes under the quoted message (quoted lines prefixed with '> ' in plain text) and the signature comes last, after a line made of two dashes and a space. Off: reply above, signature between your text and the quote, as in Outlook and Gmail."
				checked={enabled}
				disabled={pending}
				onChange={(e) => onChange(e.currentTarget.checked)}
			/>
			<Select
				className="mt-5"
				classNames={{ wrapper: "max-w-xs" }}
				label="Undo send"
				description="How long you can cancel a message after clicking Send."
				data={undoChoices}
				value={String(undoSeconds)}
				onChange={onUndoChange}
				allowDeselect={false}
				comboboxProps={{ withinPortal: true }}
			/>
		</SectionCard>
	);
}

export default SettingsComposeStyle;
