"use client";
import React, { useState, useTransition } from "react";
import { SegmentedControl } from "@mantine/core";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { setInterfaceMode, type InterfaceMode } from "@/lib/actions/interface-pref";


// Per-user choice of the mail interface. Classic by default; the modern
// three-column interface is opt-in.
function SettingsInterface({ mode: initial }: { mode: InterfaceMode }) {
	const [mode, setMode] = useState<InterfaceMode>(initial);
	const [pending, startTransition] = useTransition();
	const onChange = (value: string) => {
		const next: InterfaceMode = value === "modern" ? "modern" : "classic";
		const previous = mode;
		setMode(next);
		startTransition(async () => {
			const r = await setInterfaceMode(next);
			if (r?.success === false) {
				setMode(previous);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			// Full reload: the page changes structure and theme.
			window.location.reload();
		});
	};

	return (
		<SectionCard
			title="Interface"
			description={"Choose between the classic layout and the modern three-column layout. This only applies to your account."}
		>
			<SegmentedControl
				value={mode}
				disabled={pending}
				onChange={onChange}
				data={[
					{ value: "classic", label: "Classic" },
					{ value: "modern", label: "Three-column" },
				]}
			/>
		</SectionCard>
	);
}

export default SettingsInterface;
