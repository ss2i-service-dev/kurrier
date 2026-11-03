"use client";
import React, { useEffect, useRef, useState } from "react";
import { IconGripVertical, IconX } from "@tabler/icons-react";
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
	addRecipients,
	RECIPIENT_DRAG_TYPE,
	RECIPIENT_FIELDS,
	type RecipientField,
} from "@/components/mailbox/default/editor/recipients-move";
import ContactSuggestionItem from "@/components/mailbox/default/editor/contact-suggestion-item";
import { suggestRecipients } from "@/lib/actions/recipient-suggestions";

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
	// ss2i : menu contextuel d'une pastille (alternative au glisser-deposer).
	const [menu, setMenu] = useState<{ x: number; y: number; email: string } | null>(null);
	const [searchValue, setSearchValue] = useState("");
	const [options, setOptions] = useState<ComboboxItem[]>([]);

	const update = (v: string[]) => {
		valueRef.current = v;
		setValue(v);
		onChange?.(v);
	};

	// Enregistrement aupres du fournisseur de glisser-deposer (To / Cc / Bcc).
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

	// ss2i : les pastilles sont les notres, hors du TagsInput. Celles de Mantine vivaient
	// dans le PillsInput, dont le mousedown fait preventDefault (pour garder le focus) :
	// le navigateur ne demarrait jamais de glisser, et un clic ouvrait les suggestions.
	// Le TagsInput ne sert plus qu'a saisir une nouvelle adresse (valeur toujours vide) ;
	// le champ cache lu par le formulaire est le notre, meme format (virgules).
	const add = (emails: string[]) => {
		let next = addRecipients(valueRef.current, emails.map((e) => e.trim()).filter(Boolean));
		if (maxTags) next = next.slice(0, maxTags);
		if (next !== valueRef.current) update(next);
	};
	const remove = (email: string) => update(valueRef.current.filter((e) => e !== email));

	// ss2i : suggestions classees par usage reel cote serveur (recence, frequence,
	// association avec les adresses deja saisies dans les trois champs) ; le texte tape
	// ne fait que filtrer. Champ vide au focus : les meilleurs candidats tout de suite.
	// Une reponse en retard ne remplace jamais une plus recente.
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

	const renderOption: TagsInputProps["renderOption"] = ({ option }) => (
		<ContactSuggestionItem option={option} />
	);

	// Ordre du serveur conserve : le filtrage textuel est deja fait la-bas.
	const filter: OptionsFilter = ({ options }) => options;

	return (
		<div className="flex flex-wrap items-center gap-1 w-full min-h-[28px]">
			<input type="hidden" name={name} value={value.join(",")} />
			{value.map((email) => (
				<span
					key={email}
					draggable={!!dnd}
					onDragStart={(e) => {
						e.dataTransfer.setData(RECIPIENT_DRAG_TYPE, JSON.stringify({ email, from: name }));
						e.dataTransfer.effectAllowed = "move";
						// Differe : modifier le DOM pendant dragstart peut annuler le glisser (Chrome).
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
			<FocusTrap active={true}>
				<TagsInput
					value={[]}
					searchValue={searchValue}
					onSearchChange={searchContacts}
					onFocus={() => void loadSuggestions(searchValue)}
					onKeyDown={(e) => {
						// Retour arriere dans un champ vide : retire la derniere adresse, comme avant.
						if (e.key === "Backspace" && !searchValue && valueRef.current.length) {
							remove(valueRef.current[valueRef.current.length - 1]);
						}
					}}
					data={options}
					onChange={(v) => {
						add(v);
						setSearchValue("");
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
