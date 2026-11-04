"use client";
import { useK } from "@/components/k/ui-context";
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

// Adresse d'une saisie (« a@b.c » ou « Nom <a@b.c> »), null si ce n'en est pas une.
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
	/** ss2i : prend le focus a l'ouverture (nouveau message, transfert, champ ajoute a la main). */
	autoFocus?: boolean;
	maxTags?: number;
	onChange?: (value: string[]) => void;
	name: RecipientField;
}) {
	const t = useK(); // ss2i : francais dans la nouvelle interface
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
	// ss2i : seule une vraie adresse devient une pastille. « Nom <a@b.c> » donne a@b.c ;
	// un texte sans @ (« dev ») n'est jamais accepte : il partait en copie sans adresse
	// et l'envoi l'ignorait sans rien dire (Re: Unisens - Bitwarden, 03/11).
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
	// Entree, virgule : la suggestion surlignee (Mantine s'en charge), a defaut la premiere
	// suggestion, a defaut le texte tape s'il est une adresse. Jamais le texte brut.
	const wrapRef = useRef<HTMLDivElement>(null);
	const commitTyped = (e: React.KeyboardEvent) => {
		const typed = searchValue.trim();
		if (!typed) return;
		const highlighted = wrapRef.current?.querySelector("[data-combobox-selected]");
		if (e.key === "Enter" && highlighted) return; // option choisie au clavier
		e.preventDefault();
		e.stopPropagation();
		// Premiere suggestion correspondant au texte tape (une liste en retard sur la
		// frappe ne doit pas imposer un destinataire sans rapport).
		const first = enterPick;
		const pick = emailOf(typed) ?? first ?? typed;
		const bad = add([pick]);
		setSearchValue(bad.length ? typed : "");
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

	// Suggestion que prendra Entree (sans option surlignee au clavier) : marquee.
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

	// Ordre du serveur conserve : le filtrage textuel est deja fait la-bas.
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
						// Differe : modifier le DOM pendant dragstart peut annuler le glisser (Chrome).
						setTimeout(() => dnd?.setDragging(name), 0);
					}}
					onDragEnd={() => dnd?.setDragging(null)}
					onContextMenu={(e) => {
						if (!dnd) return;
						e.preventDefault();
						setMenu({ x: e.clientX, y: e.clientY, email });
					}}
					title={dnd ? t("Drag to To, Cc or Bcc (right-click: Move to)", "Glisser vers À, Cc ou Cci (clic droit : Déplacer vers)") : email}
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
						aria-label={t(`Remove ${email}`, `Retirer ${email}`)}
						title={t("Remove", "Retirer")}
						onClick={() => remove(email)}
						className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
					>
						<IconX size={12} />
					</button>
				</span>
			))}
			<FocusTrap active={autoFocus}>
				<TagsInput
					data-k-autofocus={autoFocus ? "true" : undefined}
					value={[]}
					searchValue={searchValue}
					onSearchChange={searchContacts}
					onFocus={() => void loadSuggestions(searchValue)}
					onKeyDown={(e) => {
						// Retour arriere dans un champ vide : retire la derniere adresse, comme avant.
						if (e.key === "Backspace" && !searchValue && valueRef.current.length) {
							remove(valueRef.current[valueRef.current.length - 1]);
						}
						if (e.key === "Enter" || e.key === ",") commitTyped(e);
					}}
					// Perte du focus : une adresse complete est gardee, un debut de saisie reste
					// dans le champ au lieu de devenir un destinataire.
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
								{t("Move to", "Déplacer vers")} {f === "to" ? t("To", "À") : f === "cc" ? "Cc" : t("Bcc", "Cci")}
							</Menu.Item>
						))}
					</Menu.Dropdown>
				</Menu>
			)}
		</div>
	);
}
