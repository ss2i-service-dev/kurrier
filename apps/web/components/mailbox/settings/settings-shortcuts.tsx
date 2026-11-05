"use client";
// Settings > Keyboard shortcuts (both interfaces). Lists the shortcuts and lets
// the user change keys, reset and disable them. Every change is saved at once
// (lib/actions/shortcuts.ts) and applied without reloading
// (components/k/shortcuts-config.tsx).
import React, { useEffect, useRef, useState } from "react";
import { Switch } from "@mantine/core";
import { toast } from "sonner";
import { Plus, RotateCcw, X } from "lucide-react";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import { useModernUi } from "@/components/k/ui-context";
import { saveShortcutPrefs } from "@/lib/actions/shortcuts";
import { setShortcutPrefsLocal, setShortcutRecording } from "@/components/k/shortcuts-config";
import {
	comboFromEvent,
	formatCombo,
	GROUPS,
	MAX_KEYS_PER_SHORTCUT,
	resolveBindings,
	SHORTCUTS,
	type ShortcutId,
	type ShortcutPrefs,
} from "@/components/k/shortcuts-catalog";

type Conflict = { id: ShortcutId; combo: string; other: ShortcutId };

export default function SettingsShortcuts({ initial }: { initial: ShortcutPrefs }) {
	const nv = useModernUi();
	const [prefs, setPrefs] = useState<ShortcutPrefs>(initial);
	const [recording, setRecording] = useState<ShortcutId | null>(null);
	const [conflict, setConflict] = useState<Conflict | null>(null);
	const saving = useRef(0);

	const visible = SHORTCUTS.filter((s) => nv || !s.modernOnly);
	const bindings = resolveBindings(prefs);
	const label = (id: ShortcutId) => {
		const s = SHORTCUTS.find((x) => x.id === id)!;
		return s.en;
	};

	useEffect(() => {
		setShortcutRecording(recording !== null);
		return () => setShortcutRecording(false);
	}, [recording]);

	const commit = (next: ShortcutPrefs) => {
		const previous = prefs;
		setPrefs(next);
		setShortcutPrefsLocal(next);
		const ticket = ++saving.current;
		saveShortcutPrefs(next)
			.then((r) => {
				if (ticket !== saving.current) return;
				if (!r?.success) throw new Error(r?.error);
			})
			.catch(() => {
				if (ticket !== saving.current) return;
				setPrefs(previous);
				setShortcutPrefsLocal(previous);
				toast.error("Could not save the shortcuts");
			});
	};

	const withKeys = (base: ShortcutPrefs, id: ShortcutId, keys: string[]): ShortcutPrefs => ({
		...base,
		keys: { ...base.keys, [id]: keys },
	});

	const addKey = (id: ShortcutId, combo: string) => {
		setRecording(null);
		if (bindings[id].includes(combo)) return;
		const other = visible.find((s) => s.id !== id && bindings[s.id].includes(combo));
		if (other) {
			setConflict({ id, combo, other: other.id });
			return;
		}
		commit(withKeys(prefs, id, [...bindings[id], combo].slice(-MAX_KEYS_PER_SHORTCUT)));
	};

	const replaceConflict = () => {
		if (!conflict) return;
		const { id, combo, other } = conflict;
		let next = withKeys(prefs, other, bindings[other].filter((c) => c !== combo));
		next = withKeys(next, id, [...bindings[id], combo].slice(-MAX_KEYS_PER_SHORTCUT));
		setConflict(null);
		commit(next);
	};

	const removeKey = (id: ShortcutId, combo: string) =>
		commit(withKeys(prefs, id, bindings[id].filter((c) => c !== combo)));

	const resetOne = (id: ShortcutId) => {
		const keys = { ...prefs.keys };
		delete keys[id];
		commit({ ...prefs, keys });
	};

	const resetAll = () => {
		setConflict(null);
		commit({ enabled: true, keys: {} });
	};

	const customized = (id: ShortcutId) => !!prefs.keys[id];
	const anyCustom = visible.some((s) => customized(s.id)) || !prefs.enabled;

	// Styles depend on the interface (modern: k-* tokens, classic: original palette).
	const c = nv
		? {
				group: "text-[12px] font-semibold uppercase tracking-wide text-k-ink-3",
				row: "border-t border-k-line first:border-t-0",
				label: "text-[13.5px] text-k-ink",
				kbd: "inline-flex items-center gap-1 rounded-md border border-k-line-strong bg-k-hover px-1.5 py-0.5 font-mono text-[12px] text-k-ink",
				ghost: "inline-flex items-center gap-1 rounded-k-sm px-2 py-1 text-[12.5px] text-k-ink-2 hover:bg-k-hover hover:text-k-ink",
				rec: "inline-flex items-center rounded-md border border-k-accent bg-k-accent-soft px-2 py-0.5 text-[12px] text-k-accent outline-none",
				warn: "mt-2 rounded-k-sm border border-k-line bg-k-surface-2 px-3 py-2 text-[12.5px] text-k-ink-2",
				muted: "text-[12.5px] text-k-ink-3",
				x: "text-k-ink-3 hover:text-k-danger",
			}
		: {
				group: "text-xs font-semibold uppercase tracking-wide text-neutral-500",
				row: "border-t border-neutral-200 first:border-t-0 dark:border-neutral-800",
				label: "text-sm text-neutral-900 dark:text-neutral-100",
				kbd: "inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-800 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100",
				ghost: "inline-flex items-center gap-1 rounded-md px-2 py-1 !text-xs text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100",
				rec: "inline-flex items-center rounded-md border border-brand bg-brand/10 px-2 py-0.5 text-xs text-brand outline-none dark:text-brand-foreground",
				warn: "mt-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300",
				muted: "text-xs text-neutral-500",
				x: "text-neutral-400 hover:text-red-600",
			};

	return (
		<SectionCard
			title={"Keyboard shortcuts"}
			description={"Keys that trigger an action. Shortcuts without Ctrl or Alt are ignored while typing. Press ? anywhere in the mailbox to see them."}
			footer={
				<div className="flex items-center justify-between gap-3">
					<span className={c.muted}>
						{"Saved to your account, on every device."}
					</span>
					<button type="button" className={c.ghost} onClick={resetAll} disabled={!anyCustom}>
						<RotateCcw size={13} />
						{"Reset all"}
					</button>
				</div>
			}
		>
			<Switch
				label={"Enable keyboard shortcuts"}
				checked={prefs.enabled}
				onChange={(e) => commit({ ...prefs, enabled: e.currentTarget.checked })}
			/>

			<div className={`mt-5 space-y-5 ${prefs.enabled ? "" : "pointer-events-none opacity-50"}`} aria-disabled={!prefs.enabled}>
				{GROUPS.map((g) => {
					const items = visible.filter((s) => s.group === g.id);
					if (!items.length) return null;
					return (
						<div key={g.id}>
							<div className={c.group}>{g.en}</div>
							<ul className="mt-1.5">
								{items.map((s) => {
									const keys = bindings[s.id];
									const isRec = recording === s.id;
									const rowConflict = conflict?.id === s.id ? conflict : null;
									return (
										<li key={s.id} className={`py-2 ${c.row}`}>
											<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
												<span className={`min-w-0 flex-1 ${c.label}`}>{s.en}</span>
												<div className="flex flex-wrap items-center gap-1.5">
													{keys.length === 0 && !isRec && (
														<span className={c.muted}>{"No key"}</span>
													)}
													{keys.map((combo) => (
														<span key={combo} className={c.kbd}>
															{formatCombo(combo)}
															<button
																type="button"
																aria-label={`Remove ${formatCombo(combo)}`}
																className={c.x}
																onClick={() => removeKey(s.id, combo)}
															>
																<X size={12} />
															</button>
														</span>
													))}
													{isRec ? (
														<KeyRecorder
															className={c.rec}
															text={"Press a key…"}
															onCombo={(combo) => addKey(s.id, combo)}
															onCancel={() => setRecording(null)}
														/>
													) : (
														keys.length < MAX_KEYS_PER_SHORTCUT && (
															<button
																type="button"
																className={c.ghost}
																onClick={() => {
																	setConflict(null);
																	setRecording(s.id);
																}}
															>
																<Plus size={13} />
																{keys.length ? "Add" : "Set"}
															</button>
														)
													)}
													{customized(s.id) && (
														<button
															type="button"
															className={c.ghost}
															title={`Default: ${s.defaults.map((d) => formatCombo(d)).join(", ") || "none"}`}
															onClick={() => resetOne(s.id)}
														>
															<RotateCcw size={13} />
															{"Default"}
														</button>
													)}
												</div>
											</div>
											{rowConflict && (
												<div className={c.warn}>
													{`${formatCombo(rowConflict.combo)} is already used for “${label(rowConflict.other)}”.`}{" "}
													<button type="button" className={`${c.ghost} font-medium`} onClick={replaceConflict}>
														{"Use it here instead"}
													</button>
													<button type="button" className={c.ghost} onClick={() => setConflict(null)}>
														{"Cancel"}
													</button>
												</div>
											)}
										</li>
									);
								})}
							</ul>
						</div>
					);
				})}
			</div>
		</SectionCard>
	);
}

/** Captures the next key combination; a click elsewhere or Tab cancels. */
function KeyRecorder({
	text,
	className,
	onCombo,
	onCancel,
}: {
	text: string;
	className: string;
	onCombo: (combo: string) => void;
	onCancel: () => void;
}) {
	const ref = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		ref.current?.focus();
	}, []);
	return (
		<button
			ref={ref}
			type="button"
			className={className}
			onBlur={onCancel}
			onKeyDown={(e) => {
				if (e.key === "Tab") return onCancel();
				const combo = comboFromEvent(e);
				e.preventDefault();
				e.stopPropagation();
				if (combo) onCombo(combo);
			}}
		>
			{text}
		</button>
	);
}
