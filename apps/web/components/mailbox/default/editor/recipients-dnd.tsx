"use client";
import React, {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	addRecipients,
	moveRecipient,
	RECIPIENT_DRAG_TYPE,
	type RecipientField,
} from "@/components/mailbox/default/editor/recipients-move";

type FieldApi = { get: () => string[]; set: (v: string[]) => void };

type Ctx = {
	register: (name: RecipientField, api: FieldApi) => () => void;
	move: (email: string, from: RecipientField, to: RecipientField) => void;
	// Toutes les adresses saisies, To, Cc et Bcc confondus (suggestions par association).
	all: () => string[];
	// Champ d'origine du glisser en cours (null hors glisser) : les zones de depot s'affichent.
	dragging: RecipientField | null;
	setDragging: (f: RecipientField | null) => void;
};

const RecipientsDnDContext = createContext<Ctx | null>(null);

export const useRecipientsDnD = () => useContext(RecipientsDnDContext);

// Les champs To / Cc / Bcc s'y enregistrent ; un deplacement lit et ecrit leurs listes.
// L'enregistrement automatique relit le formulaire chaque seconde : le champ cache du
// TagsInput controle suffit, aucun evenement a emettre.
export function RecipientsDnDProvider({
	onActivate,
	children,
}: {
	// Rend visible un champ masque (Cc, Bcc) qui recoit une adresse.
	onActivate: (name: RecipientField) => void;
	children: React.ReactNode;
}) {
	const fields = useRef<Partial<Record<RecipientField, FieldApi>>>({});
	// Adresses destinees a un champ pas encore monte : appliquees a son enregistrement.
	const pending = useRef<Partial<Record<RecipientField, string[]>>>({});

	const register = useCallback((name: RecipientField, api: FieldApi) => {
		fields.current[name] = api;
		const waiting = pending.current[name];
		if (waiting?.length) {
			delete pending.current[name];
			api.set(addRecipients(api.get(), waiting));
		}
		return () => {
			if (fields.current[name] === api) delete fields.current[name];
		};
	}, []);

	const move = useCallback(
		(email: string, from: RecipientField, to: RecipientField) => {
			if (from === to) return;
			const src = fields.current[from];
			const dst = fields.current[to];
			const next = moveRecipient(
				{
					to: [],
					cc: [],
					bcc: [],
					[from]: src?.get() ?? [],
					[to]: dst?.get() ?? pending.current[to] ?? [],
				},
				email,
				from,
				to,
			);
			src?.set(next[from]);
			if (dst) dst.set(next[to]);
			else {
				pending.current[to] = next[to];
				onActivate(to);
			}
		},
		[onActivate],
	);

	const all = useCallback(
		() => Object.values(fields.current).flatMap((api) => api?.get() ?? []),
		[],
	);

	const [dragging, setDragging] = useState<RecipientField | null>(null);
	// La pastille glissee est demontee par le deplacement : son dragend n'arrive jamais.
	// Fin de glisser lue au niveau de la fenetre (drop, dragend, ou souris qui bouge a
	// nouveau, aucun mousemove n'etant emis pendant un glisser).
	useEffect(() => {
		if (!dragging) return;
		const end = () => setDragging(null);
		const events = ["drop", "dragend", "mousemove"] as const;
		events.forEach((ev) => window.addEventListener(ev, end, true));
		return () => events.forEach((ev) => window.removeEventListener(ev, end, true));
	}, [dragging]);

	const value = useMemo(
		() => ({ register, move, all, dragging, setDragging }),
		[register, move, all, dragging],
	);
	return (
		<RecipientsDnDContext.Provider value={value}>
			{children}
		</RecipientsDnDContext.Provider>
	);
}

// Zone de depot : ligne d'un champ ou bouton qui le fait apparaitre.
export function RecipientDropZone({
	name,
	className = "",
	as: Tag = "div",
	children,
}: {
	name: RecipientField;
	className?: string;
	as?: "div" | "span";
	children: React.ReactNode;
}) {
	const dnd = useRecipientsDnD();
	const [over, setOver] = useState(false);
	const accepts = (e: React.DragEvent) =>
		!!dnd && Array.from(e.dataTransfer.types).includes(RECIPIENT_DRAG_TYPE);

	return (
		<Tag
			className={`${className} rounded transition-colors ${
				over
					? "outline-dashed outline-2 outline-primary bg-primary/15"
					: dnd?.dragging && dnd.dragging !== name
						? "outline-dashed outline-1 outline-primary/50"
						: ""
			}`}
			onDragOver={(e: React.DragEvent) => {
				if (!accepts(e)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = "move";
				if (!over) setOver(true);
			}}
			onDragLeave={(e: React.DragEvent) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
			}}
			onDrop={(e: React.DragEvent) => {
				setOver(false);
				dnd?.setDragging(null);
				if (!accepts(e)) return;
				e.preventDefault();
				try {
					const { email, from } = JSON.parse(
						e.dataTransfer.getData(RECIPIENT_DRAG_TYPE),
					);
					if (email && from) dnd!.move(email, from, name);
				} catch {
					// charge illisible : rien a faire
				}
			}}
		>
			{children}
		</Tag>
	);
}
