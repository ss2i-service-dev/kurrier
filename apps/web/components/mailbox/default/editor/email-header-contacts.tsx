"use client";

import React, { useEffect, useRef, useState } from "react";
import { IconGripVertical, IconX } from "@tabler/icons-react";
import {
	ComboboxItem,
	TagsInput,
	TagsInputProps,
	OptionsFilter,
	Menu,
} from "@mantine/core";
import { useRecipientsDnD } from "@/components/mailbox/default/editor/recipients-dnd";
import {
	addRecipients,
	RECIPIENT_DRAG_TYPE,
	RECIPIENT_FIELDS,
	type RecipientField,
} from "@/components/mailbox/default/editor/recipients-move";
import ContactSuggestionItem from "@/components/mailbox/default/editor/contact-suggestion-item";
import { suggestRecipients } from "@/lib/actions/recipient-suggestions";

// Address of an input ("a@b.c" or "Name <a@b.c>"), null if it is not one.
export function emailOf(input: string): string | null {
	const m = input.match(/<([^<>]+)>\s*$/);
	const addr = (m ? m[1] : input).trim();
	return /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(addr) ? addr : null;
}

export default function EmailHeaderContacts({
	name,
	defaultValues,
	maxTags,
	onChange,
	autoFocus = false,
}: {
	defaultValues?: string[];
	/** Takes focus on mount (new message, forward, manually added field). */
	autoFocus?: boolean;
	maxTags?: number;
	onChange?: (value: string[]) => void;
	name: RecipientField;
}) {
	const dnd = useRecipientsDnD();
	const [value, setValue] = useState<string[]>(defaultValues ?? []);
	const valueRef = useRef(value);
	// Context menu of a pill (alternative to drag and drop).
	const [menu, setMenu] = useState<{ x: number; y: number; email: string } | null>(null);
	const [searchValue, setSearchValue] = useState("");
	const [options, setOptions] = useState<ComboboxItem[]>([]);

	const update = (v: string[]) => {
		valueRef.current = v;
		setValue(v);
		onChange?.(v);
	};

	// Registers with the drag-and-drop provider (To / Cc / Bcc).
	useEffect(() => {
		if (!dnd) return;
		return dnd.register(name, {
			get: () => valueRef.current,
			set: (v) => {
				valueRef.current = v;
				setValue(v);
			},
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dnd, name]);

	// The pills are ours, outside the TagsInput. Mantine's pills lived inside the
	// PillsInput, whose mousedown calls preventDefault (to keep focus): the browser
	// never started a drag, and a click opened the suggestions.
	// The TagsInput is only used to type a new address (its value is always empty);
	// the hidden field read by the form is ours, same format (commas).
	// Only a real address becomes a pill. "Name <a@b.c>" gives a@b.c; text without an @
	// ("dev") is never accepted: it used to be added as a recipient without an address
	// and sending silently ignored it.
	const [inputError, setInputError] = useState<string | null>(null);
	const add = (emails: string[]) => {
		const ok: string[] = [];
		const bad: string[] = [];
		for (const raw of emails) {
			const e = raw.trim();
			if (!e) continue;
			const addr = emailOf(e);
			(addr ? ok : bad).push(addr ?? e);
		}
		let next = addRecipients(valueRef.current, ok);
		if (maxTags) next = next.slice(0, maxTags);
		if (next !== valueRef.current) update(next);
		setInputError(bad.length ? `"${bad.join(", ")}" is not an email address` : null);
		return bad;
	};
	// Enter, comma: the highlighted suggestion (Mantine handles it), else the first
	// suggestion, else the typed text if it is an address. Never the raw text.
	const wrapRef = useRef<HTMLDivElement>(null);
	const commitTyped = (e: React.KeyboardEvent) => {
		const typed = searchValue.trim();
		if (!typed) return;
		const highlighted = wrapRef.current?.querySelector("[data-combobox-selected]");
		if (e.key === "Enter" && highlighted) return; // option chosen with the keyboard
		e.preventDefault();
		e.stopPropagation();
		// First suggestion matching the typed text (a list lagging behind the typing
		// must not force an unrelated recipient).
		const first = enterPick;
		const pick = emailOf(typed) ?? first ?? typed;
		const bad = add([pick]);
		setSearchValue(bad.length ? typed : "");
	};
	const remove = (email: string) => update(valueRef.current.filter((e) => e !== email));

	// Suggestions ranked server-side by actual usage (recency, frequency, association
	// with the addresses already entered in the three fields); the typed text only
	// filters. Empty field on focus: the best candidates right away.
	// A late response never replaces a more recent one.
	const requestSeq = useRef(0);
	const loadSuggestions = async (val: string) => {
		const seq = ++requestSeq.current;
		const current = Array.from(
			new Set([...(dnd?.all() ?? []), ...valueRef.current].map((e) => e.toLowerCase())),
		);
		const rows = await suggestRecipients({ query: val, current });
		if (seq !== requestSeq.current) return;
		setOptions(
			rows.map((row) => ({
				value: row.email,
				label: row.name && row.name !== row.email ? `${row.name} <${row.email}>` : row.email,
				avatar: row.avatar,
			})),
		);
	};

	const searchContacts = (val: string) => {
		setSearchValue(val);
		void loadSuggestions(val);
	};

	// Suggestion that Enter will pick (no option highlighted with the keyboard): marked.
	const typedLower = searchValue.trim().toLowerCase();
	const enterPick =
		typedLower && !emailOf(searchValue.trim())
			? options.find((o) => `${o.label} ${o.value}`.toLowerCase().includes(typedLower))?.value
			: undefined;
	const renderOption: TagsInputProps["renderOption"] = ({ option }) => (
		<div className="flex w-full items-center justify-between gap-2">
			<ContactSuggestionItem option={option} />
			{option.value === enterPick && (
				<kbd className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">Enter</kbd>
			)}
		</div>
	);

	// Server order kept: text filtering is already done there.
	const filter: OptionsFilter = ({ options }) => options;

	return (
		<div ref={wrapRef} className="flex flex-wrap items-center gap-1 w-full min-h-[28px]">
			<input type="hidden" name={name} value={value.join(",")} />
			{value.map((email) => (
				<span
					key={email}
					draggable={!!dnd}
					onDragStart={(e) => {
						e.dataTransfer.setData(RECIPIENT_DRAG_TYPE, JSON.stringify({ email, from: name }));
						e.dataTransfer.effectAllowed = "move";
						// Deferred: changing the DOM during dragstart can cancel the drag (Chrome).
						setTimeout(() => dnd?.setDragging(name), 0);
					}}
					onDragEnd={() => dnd?.setDragging(null)}
					onContextMenu={(e) => {
						if (!dnd) return;
						e.preventDefault();
						setMenu({ x: e.clientX, y: e.clientY, email });
					}}
					title={dnd ? "Drag to To, Cc or Bcc (right-click: Move to)" : email}
					className="group inline-flex items-center gap-0.5 rounded-full border border-border bg-muted pl-0.5 pr-1 py-0.5 text-[13px] leading-5 select-none"
				>
					{dnd && (
						<IconGripVertical
							size={14}
							aria-hidden
							className="cursor-grab active:cursor-grabbing text-muted-foreground group-hover:text-foreground"
						/>
					)}
					<span className="cursor-grab active:cursor-grabbing">{email}</span>
					<button
						type="button"
						aria-label={`Remove ${email}`}
						title="Remove"
						onClick={() => remove(email)}
						className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
					>
						<IconX size={12} />
					</button>
				</span>
			))}
			<>
				<TagsInput
					autoFocus={autoFocus}
					data-k-autofocus={autoFocus ? "true" : undefined}
					value={[]}
					searchValue={searchValue}
					onSearchChange={searchContacts}
					onFocus={() => void loadSuggestions(searchValue)}
					onKeyDown={(e) => {
						// Backspace in an empty field removes the last address.
						if (e.key === "Backspace" && !searchValue && valueRef.current.length) {
							remove(valueRef.current[valueRef.current.length - 1]);
						}
						if (e.key === "Enter" || e.key === ",") commitTyped(e);
					}}
					// On blur: a complete address is kept, a partial input stays in the
					// field instead of becoming a recipient.
					acceptValueOnBlur={false}
					onBlur={() => {
						const typed = searchValue.trim();
						if (typed && emailOf(typed) && !add([typed]).length) setSearchValue("");
					}}
					error={inputError ?? undefined}
					data={options}
					onChange={(v) => {
						const bad = add(v);
						setSearchValue(bad.length ? bad.join(", ") : "");
					}}
					renderOption={renderOption}
					filter={filter}
					size="sm"
					variant="unstyled"
					className="min-h-[28px] text-sm flex-1 min-w-[14rem]"
					comboboxProps={{
						dropdownPadding: 0,
						withinPortal: false,
						position: "bottom-start",
						offset: 1,
						width: "target",
						shadow: "0 4px 6px rgba(0, 0, 0, 0.1)",
						transitionProps: { transition: "skew-down", duration: 150 },
					}}
				/>
			</>
			{menu && (
				<Menu opened onChange={(o) => !o && setMenu(null)} withinPortal position="bottom-start" zIndex={3000}>
					<Menu.Target>
						<div style={{ position: "fixed", left: menu.x, top: menu.y, width: 0, height: 0 }} />
					</Menu.Target>
					<Menu.Dropdown>
						{RECIPIENT_FIELDS.filter((f) => f !== name).map((f) => (
							<Menu.Item
								key={f}
								onClick={() => {
									dnd?.move(menu.email, name, f);
									setMenu(null);
								}}
							>
								Move to {f === "to" ? "To" : f === "cc" ? "Cc" : "Bcc"}
							</Menu.Item>
						))}
					</Menu.Dropdown>
				</Menu>
			)}
		</div>
	);
}
