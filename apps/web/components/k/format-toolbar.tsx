"use client";
// SS2i (nouvelle interface) : mise en forme du texte dans l'editeur de mail.
// Barre complete (style, taille, gras..., couleurs, alignement, listes, citation,
// lien, code, effacer ; annuler / retablir au clavier : Ctrl+Z, Ctrl+Maj+Z) rangee au-dessus du texte, et mini-barre
// flottante sur une selection. Rendue dans <RichTextEditor> (contexte Mantine).
import React from "react";
import { RichTextEditor, useRichTextEditorContext } from "@mantine/tiptap";
import { BubbleMenu } from "@tiptap/react/menus";
import { Popover, Tooltip } from "@mantine/core";
import { useEditorState } from "@tiptap/react";
import { Baseline, ChevronDown, Highlighter, RemoveFormatting, Type } from "lucide-react";

// Couleurs sures en mail (lisibles sur fond clair, rendues partout).
const TEXT_COLORS = [
	"#1b1a19", "#57534e", "#8c877f", "#c0392b", "#d35400", "#b7950b",
	"#1e8449", "#117a65", "#2471a3", "#3555d6", "#7d3c98", "#a93263",
];
const HIGHLIGHTS = ["#fff3a3", "#ffd8a8", "#ffc9c9", "#d3f9d8", "#c5f6fa", "#d0ebff", "#e5dbff", "#f1f3f5"];

const SIZES: { label: string; value: string | null }[] = [
	{ label: "Petit", value: "12px" },
	{ label: "Normal", value: null },
	{ label: "Grand", value: "18px" },
	{ label: "Très grand", value: "24px" },
];

/** Libelles francais des controles Mantine (infobulles), passes a <RichTextEditor labels>. */
export const K_EDITOR_LABELS = {
	boldControlLabel: "Gras (Ctrl+B)",
	italicControlLabel: "Italique (Ctrl+I)",
	underlineControlLabel: "Souligné (Ctrl+U)",
	strikeControlLabel: "Barré",
	clearFormattingControlLabel: "Effacer la mise en forme",
	linkControlLabel: "Lien (Ctrl+K)",
	unlinkControlLabel: "Retirer le lien",
	bulletListControlLabel: "Liste à puces",
	orderedListControlLabel: "Liste numérotée",
	h1ControlLabel: "Titre 1",
	h2ControlLabel: "Titre 2",
	h3ControlLabel: "Titre 3",
	blockquoteControlLabel: "Citation",
	codeControlLabel: "Code",
	hrControlLabel: "Ligne de séparation",
	alignLeftControlLabel: "Aligner à gauche",
	alignCenterControlLabel: "Centrer",
	alignRightControlLabel: "Aligner à droite",
	alignJustifyControlLabel: "Justifier",
	undoControlLabel: "Annuler (Ctrl+Z)",
	redoControlLabel: "Rétablir (Ctrl+Maj+Z)",
	colorPickerControlLabel: "Couleur du texte",
	unsetColorControlLabel: "Couleur par défaut",
	highlightControlLabel: "Surligner",
	linkEditorInputLabel: "Adresse du lien",
	linkEditorInputPlaceholder: "https://exemple.fr",
	linkEditorExternalLink: "Ouvrir dans un nouvel onglet",
	linkEditorInternalLink: "Ouvrir dans le même onglet",
	linkEditorSave: "Enregistrer",
	colorControlLabel: (color: string) => `Couleur ${color}`,
} as const;

function useEditorFlags() {
	const { editor } = useRichTextEditorContext();
	return useEditorState({
		editor,
		selector: (ctx) => {
			const e = ctx.editor;
			if (!e) return { block: "p", size: null as string | null, color: null as string | null, highlight: null as string | null };
			const block = e.isActive("heading", { level: 1 })
				? "h1"
				: e.isActive("heading", { level: 2 })
					? "h2"
					: e.isActive("heading", { level: 3 })
						? "h3"
						: "p";
			const ts = e.getAttributes("textStyle") ?? {};
			return {
				block,
				size: (ts.fontSize as string) ?? null,
				color: (ts.color as string) ?? null,
				highlight: (e.getAttributes("highlight")?.color as string) ?? null,
			};
		},
	}) ?? { block: "p", size: null, color: null, highlight: null };
}

const menuBtn =
	"flex h-8 items-center gap-1 rounded-k-sm px-2 text-[12.5px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink";

function BlockStyle() {
	const { editor } = useRichTextEditorContext();
	const { block } = useEditorFlags();
	const items = [
		{ id: "p", label: "Texte", cls: "text-[13px]", run: () => editor?.chain().focus().setParagraph().run() },
		{ id: "h1", label: "Titre 1", cls: "text-[18px] font-semibold", run: () => editor?.chain().focus().setHeading({ level: 1 }).run() },
		{ id: "h2", label: "Titre 2", cls: "text-[16px] font-semibold", run: () => editor?.chain().focus().setHeading({ level: 2 }).run() },
		{ id: "h3", label: "Titre 3", cls: "text-[14px] font-semibold", run: () => editor?.chain().focus().setHeading({ level: 3 }).run() },
	];
	const current = items.find((i) => i.id === block) ?? items[0];
	return (
		<Popover position="bottom-start" shadow="md" radius={10} withinPortal>
			<Popover.Target>
				<button type="button" className={`${menuBtn} w-[78px] justify-between`} title="Style du paragraphe">
					<span className="truncate">{current.label}</span>
					<ChevronDown size={13} />
				</button>
			</Popover.Target>
			<Popover.Dropdown className="!p-1">
				{items.map((i) => (
					<button
						key={i.id}
						type="button"
						onClick={i.run}
						className={`block w-full rounded-k-sm px-3 py-1.5 text-left text-k-ink hover:bg-k-hover ${i.cls} ${i.id === block ? "bg-k-accent-soft" : ""}`}
					>
						{i.label}
					</button>
				))}
			</Popover.Dropdown>
		</Popover>
	);
}

function FontSize() {
	const { editor } = useRichTextEditorContext();
	const { size } = useEditorFlags();
	const current = SIZES.find((s) => s.value === size) ?? SIZES[1];
	return (
		<Popover position="bottom-start" shadow="md" radius={10} withinPortal>
			<Popover.Target>
				<button type="button" className={`${menuBtn} justify-between`} title={`Taille du texte : ${current.label}`}>
					<Type size={15} className="shrink-0" />
					<ChevronDown size={13} />
				</button>
			</Popover.Target>
			<Popover.Dropdown className="!p-1">
				{SIZES.map((s) => (
					<button
						key={s.label}
						type="button"
						onClick={() =>
							s.value
								? editor?.chain().focus().setFontSize(s.value).run()
								: editor?.chain().focus().unsetFontSize().run()
						}
						className={`block w-full rounded-k-sm px-3 py-1.5 text-left text-k-ink hover:bg-k-hover ${s.value === size ? "bg-k-accent-soft" : ""}`}
						style={{ fontSize: s.value ?? "14px" }}
					>
						{s.label}
					</button>
				))}
			</Popover.Dropdown>
		</Popover>
	);
}

function Swatches({
	colors,
	active,
	onPick,
	onReset,
	resetLabel,
}: {
	colors: string[];
	active: string | null;
	onPick: (c: string) => void;
	onReset: () => void;
	resetLabel: string;
}) {
	return (
		<div className="w-[176px]">
			<div className="grid grid-cols-6 gap-1.5">
				{colors.map((c) => (
					<button
						key={c}
						type="button"
						onClick={() => onPick(c)}
						aria-label={c}
						className={`h-6 w-6 rounded-full ring-offset-2 ring-offset-[var(--k-surface)] transition-transform hover:scale-110 ${
							active?.toLowerCase() === c ? "ring-2 ring-k-accent" : "ring-1 ring-black/10"
						}`}
						style={{ background: c }}
					/>
				))}
			</div>
			<button type="button" onClick={onReset} className="mt-2 w-full rounded-k-sm px-2 py-1 text-left text-[12px] text-k-ink-2 hover:bg-k-hover">
				{resetLabel}
			</button>
		</div>
	);
}

function ColorControl({ kind }: { kind: "text" | "highlight" }) {
	const { editor } = useRichTextEditorContext();
	const { color, highlight } = useEditorFlags();
	const active = kind === "text" ? color : highlight;
	const Icon = kind === "text" ? Baseline : Highlighter;
	return (
		<Popover position="bottom" shadow="md" radius={10} withinPortal>
			<Popover.Target>
				<Tooltip label={kind === "text" ? "Couleur du texte" : "Surligner"} fz="xs" openDelay={400}>
					<button type="button" className="relative flex h-[30px] w-[30px] items-center justify-center rounded-k-sm text-k-ink-2 hover:bg-k-hover hover:text-k-ink">
						<Icon size={16} />
						<span
							className="absolute bottom-1 left-1/2 h-[3px] w-4 -translate-x-1/2 rounded-full"
							style={{ background: active ?? (kind === "text" ? "currentColor" : "transparent") }}
						/>
					</button>
				</Tooltip>
			</Popover.Target>
			<Popover.Dropdown>
				<Swatches
					colors={kind === "text" ? TEXT_COLORS : HIGHLIGHTS}
					active={active}
					onPick={(c) =>
						kind === "text"
							? editor?.chain().focus().setColor(c).run()
							: editor?.chain().focus().setHighlight({ color: c }).run()
					}
					onReset={() =>
						kind === "text" ? editor?.chain().focus().unsetColor().run() : editor?.chain().focus().unsetHighlight().run()
					}
					resetLabel={kind === "text" ? "Couleur par défaut" : "Sans surlignage"}
				/>
			</Popover.Dropdown>
		</Popover>
	);
}

function ClearAll() {
	const { editor } = useRichTextEditorContext();
	return (
		<Tooltip label="Effacer toute la mise en forme de la sélection" fz="xs" openDelay={400}>
			<button
				type="button"
				onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().unsetTextAlign().run()}
				className="flex h-[30px] w-[30px] items-center justify-center rounded-k-sm text-k-ink-2 hover:bg-k-hover hover:text-k-ink"
				aria-label="Effacer la mise en forme"
			>
				<RemoveFormatting size={16} />
			</button>
		</Tooltip>
	);
}

/** Barre complete, rangee au-dessus de la zone de texte. */
export function KFormatBar() {
	return (
		<RichTextEditor.Toolbar className="k-format-bar">
			<RichTextEditor.ControlsGroup>
				<BlockStyle />
				<FontSize />
			</RichTextEditor.ControlsGroup>
			<RichTextEditor.ControlsGroup>
				<RichTextEditor.Bold />
				<RichTextEditor.Italic />
				<RichTextEditor.Underline />
				<RichTextEditor.Strikethrough />
			</RichTextEditor.ControlsGroup>
			<RichTextEditor.ControlsGroup>
				<ColorControl kind="text" />
				<ColorControl kind="highlight" />
			</RichTextEditor.ControlsGroup>
			<RichTextEditor.ControlsGroup>
				<RichTextEditor.AlignLeft />
				<RichTextEditor.AlignCenter />
				<RichTextEditor.AlignRight />
				<RichTextEditor.AlignJustify />
			</RichTextEditor.ControlsGroup>
			<RichTextEditor.ControlsGroup>
				<RichTextEditor.BulletList />
				<RichTextEditor.OrderedList />
				<RichTextEditor.Blockquote />
				<RichTextEditor.Hr />
			</RichTextEditor.ControlsGroup>
			<RichTextEditor.ControlsGroup>
				<RichTextEditor.Link />
				<RichTextEditor.Unlink />
				<RichTextEditor.Code />
				<ClearAll />
			</RichTextEditor.ControlsGroup>
		</RichTextEditor.Toolbar>
	);
}

/** Mini-barre qui apparait sur une selection de texte. */
export function KBubbleBar() {
	const { editor } = useRichTextEditorContext();
	if (!editor) return null;
	return (
		// Rattachee a <body> (sinon coupee par la zone qui defile et masquee sous la
		// barre de mise en forme sur la premiere ligne) ; passe sous la selection
		// quand la place manque au-dessus.
		<BubbleMenu
			editor={editor}
			appendTo={() => document.body}
			style={{ zIndex: 2500 }}
			// limite = zone de texte : sur la premiere ligne, la bulle passe dessous
			options={{
				placement: "top",
				offset: 8,
				flip: { boundary: editor.view.dom as Element, padding: 4, fallbackPlacements: ["bottom"] },
				shift: { padding: 8 },
			}}
		>
			<div className="k-bubble flex items-center gap-0.5 rounded-k bg-k-surface p-1 shadow-k-pop">
				<RichTextEditor.Bold />
				<RichTextEditor.Italic />
				<RichTextEditor.Underline />
				<RichTextEditor.Link />
				<ColorControl kind="text" />
				<ColorControl kind="highlight" />
			</div>
		</BubbleMenu>
	);
}
