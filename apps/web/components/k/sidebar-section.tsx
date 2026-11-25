"use client";
// SS2i : sections pliables de la barre laterale Outlook (Dossiers, Libelles).
// L'etat est memorise sur le poste (localStorage) ; ouvert par defaut.
import * as React from "react";
import { ChevronRight } from "lucide-react";

const storageKey = (id: string) => `ss2i:k-sidebar:${id}:collapsed`;

export function useSidebarSection(id: string) {
	const [open, setOpen] = React.useState(true);
	React.useEffect(() => {
		try {
			if (window.localStorage.getItem(storageKey(id)) === "1") setOpen(false);
		} catch {}
	}, [id]);
	const toggle = React.useCallback(() => {
		setOpen((o) => {
			const next = !o;
			try {
				if (next) window.localStorage.removeItem(storageKey(id));
				else window.localStorage.setItem(storageKey(id), "1");
			} catch {}
			return next;
		});
	}, [id]);
	return { open, toggle };
}

/** Titre de section cliquable : chevron + libelle en petites capitales. */
export function SidebarSectionTitle({
	label,
	open,
	onToggle,
}: {
	label: string;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={open}
			title={open ? `Replier « ${label} »` : `Déplier « ${label} »`}
			className="k-focus -ml-1 flex items-center gap-1 rounded-k-sm py-0.5 pl-1 pr-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3 transition-colors hover:text-k-ink"
		>
			<ChevronRight size={12} className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
			{label}
		</button>
	);
}
