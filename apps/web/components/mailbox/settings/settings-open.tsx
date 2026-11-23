"use client";
// Settings > Opening mail (Three-column interface). Internal tabs of the reading pane,
// off by default, and the gesture that opens one. Each change is saved at once
// (lib/actions/open-prefs.ts) and applied without reloading (components/k/reader-tabs.ts).
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
				toast.error("Could not save the setting");
			});
	};

	const muted = "text-[12.5px] leading-relaxed text-k-ink-3";

	return (
		<SectionCard
			title="Opening mail"
			description="Open several mails at once in tabs, at the top of the reading pane. A middle click or Ctrl+click on a mail always opens it in a new browser tab, unless you give them the tabs below."
			footer={<span className={muted}>Saved on your account, on all your devices. Open tabs stay on this device.</span>}
		>
			<Switch
				label="Enable reading tabs"
				checked={prefs.tabs}
				onChange={(e) => commit({ ...prefs, tabs: e.currentTarget.checked })}
			/>

			<div className={`mt-5 ${prefs.tabs ? "" : "pointer-events-none opacity-50"}`} aria-disabled={!prefs.tabs}>
				<Radio.Group
					label="Open a mail in a tab with"
					value={prefs.gesture}
					onChange={(v) => commit({ ...prefs, gesture: v as OpenGesture })}
				>
					<div className="mt-2 space-y-3">
						<div>
							<Radio value="click" label="The click" disabled={!prefs.tabs} />
							<p className={`ml-7 mt-0.5 ${muted}`}>
								Each mail you click is added to the tabs. The middle click opens a browser tab.
							</p>
						</div>
						<div>
							<Radio value="middle" label="The middle click" disabled={!prefs.tabs} />
							<p className={`ml-7 mt-0.5 ${muted}`}>
								The middle click adds the mail to the tabs, in the background. The click opens a single mail, in place of the displayed tab.
							</p>
						</div>
					</div>
				</Radio.Group>
			</div>
		</SectionCard>
	);
}
