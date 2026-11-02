"use client";
import React, { useEffect, useRef, useState } from "react";
import {
	ComboboxItem,
	TagsInput,
	TagsInputProps,
	OptionsFilter,
	FocusTrap,
	Menu,
} from "@mantine/core";
import { useRecipientsDnD } from "@/components/mailbox/default/editor/recipients-dnd";
import {
	RECIPIENT_DRAG_TYPE,
	RECIPIENT_FIELDS,
	type RecipientField,
} from "@/components/mailbox/default/editor/recipients-move";
import ContactSuggestionItem from "@/components/mailbox/default/editor/contact-suggestion-item";
import { searchContactsForCompose } from "@/lib/actions/calendar";
import {ComposeContact} from "@schema";

export default function EmailHeaderContacts({
	name,
	defaultValues,
	maxTags,
	onChange,
}: {
	defaultValues?: string[];
	maxTags?: number;
	onChange?: (value: string[]) => void;
	name: RecipientField;
}) {
	const dnd = useRecipientsDnD();
	const [value, setValue] = useState<string[]>(defaultValues ?? []);
	const valueRef = useRef(value);
	const wrapRef = useRef<HTMLDivElement>(null);
	// ss2i : menu contextuel d'une pastille (alternative au glisser-deposer).
	const [menu, setMenu] = useState<{ x: number; y: number; email: string } | null>(null);
	const [searchValue, setSearchValue] = useState("");
	const [options, setOptions] = useState<ComboboxItem[]>([]);

	const update = (v: string[]) => {
		valueRef.current = v;
		setValue(v);
	};

	// Enregistrement aupres du fournisseur de glisser-deposer (To / Cc / Bcc).
	useEffect(() => {
		if (!dnd) return;
		return dnd.register(name, { get: () => valueRef.current, set: update });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dnd, name]);

	// Pastilles Mantine (classe statique `mantine-TagsInput-pill`, Mantine 8.3) rendues
	// glissables ; React ne les connait pas, on repose l'attribut apres chaque rendu.
	const PILL = ".mantine-TagsInput-pill";
	useEffect(() => {
		wrapRef.current?.querySelectorAll<HTMLElement>(PILL).forEach((p) => {
			p.draggable = !!dnd;
		});
	});

	const pillIndex = (target: EventTarget | null) => {
		const pill = (target as HTMLElement | null)?.closest?.(PILL) as HTMLElement | null;
		if (!pill || !wrapRef.current) return -1;
		return Array.from(wrapRef.current.querySelectorAll(PILL)).indexOf(pill);
	};

	const uniqueByEmail = (arr: ComposeContact[]) => {
		const seen = new Set();
		return arr.filter((item) => {
			if (seen.has(item.email)) return false;
			seen.add(item.email);
			return true;
		});
	};

	const searchContacts = async (val: string) => {
		setSearchValue(val);

		const rowsContacts = await searchContactsForCompose(val);
		const rows = uniqueByEmail(rowsContacts);


		const mapped: ComboboxItem[] = rows.map((row) => ({
			value: row.email,
			label: `${row.name} <${row.email}>`,
			avatar: row.avatar,
		}));

		setOptions(mapped);
	};

	const renderOption: TagsInputProps["renderOption"] = ({ option }) => (
		<ContactSuggestionItem option={option} />
	);

	const filter: OptionsFilter = ({ options, search }) => {
		const s = search.toLowerCase();
		return (options as ComboboxItem[]).filter((opt) =>
			opt.label.toLowerCase().includes(s),
		);
	};

	return (
		<div
			ref={wrapRef}
			onDragStart={(e) => {
				const email = value[pillIndex(e.target)];
				if (!dnd || !email) return;
				e.dataTransfer.setData(RECIPIENT_DRAG_TYPE, JSON.stringify({ email, from: name }));
				e.dataTransfer.effectAllowed = "move";
			}}
			onContextMenu={(e) => {
				const email = value[pillIndex(e.target)];
				if (!dnd || !email) return;
				e.preventDefault();
				setMenu({ x: e.clientX, y: e.clientY, email });
			}}
		>
			<FocusTrap active={true}>
				<TagsInput
					value={value}
					searchValue={searchValue}
					onSearchChange={searchContacts}
					data={options}
					onChange={(v) => {
						update(v);
						onChange?.(v);
					}}
					renderOption={renderOption}
					filter={filter}
					maxTags={maxTags}
					name={name}
					size="sm"
					variant="unstyled"
					className="min-h-[28px] text-sm w-96"
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
			</FocusTrap>
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
