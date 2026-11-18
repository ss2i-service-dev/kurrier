"use client";
// ss2i : apercu d'un classeur xls, xlsx ou ods dans la visionneuse (Samuel le 18/11/2026 : « et
// tant qu'a faire le csv, faut aussi faire le xls »). Octets de /api/attachments/<id>?mode=content,
// lus ici par SheetJS (import a la demande, lib/sheet-preview.ts) et rendus par React comme un CSV :
// un onglet par feuille, jamais de HTML produit par la bibliotheque.
import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import DataTable from "@/components/k/data-table";
import { parseWorkbook, type SheetData } from "@/lib/sheet-preview";
import { buildTable } from "@/lib/text-preview";

export default function SheetPreview({ url, name, downloadUrl }: { url: string; name: string; downloadUrl?: string }) {
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [sheets, setSheets] = useState<SheetData[]>([]);
	const [active, setActive] = useState(0);

	useEffect(() => {
		const controller = new AbortController();
		setState("loading");
		setSheets([]);
		setActive(0);
		(async () => {
			try {
				const response = await fetch(url, { signal: controller.signal, credentials: "same-origin" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (controller.signal.aborted) return;
				const parsed = await parseWorkbook(bytes);
				if (controller.signal.aborted) return;
				setSheets(parsed.sheets);
				setState("ready");
			} catch (error) {
				if (controller.signal.aborted) return;
				console.warn("[courrier] apercu classeur impossible", error);
				setState("error");
			}
		})();
		return () => controller.abort();
	}, [url]);

	const sheet = sheets[active];
	const table = useMemo(() => (sheet ? buildTable(sheet.rows, sheet.totalRows) : null), [sheet]);

	if (state !== "ready" || !sheet || !table) {
		return (
			<div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-k bg-white px-6 text-center text-[14px] text-neutral-600 shadow-2xl">
				{state === "loading" ? (
					<span className="flex items-center gap-2">
						<Loader2 size={18} className="animate-spin" /> Lecture du classeur…
					</span>
				) : (
					<>
						<span>L'aperçu de ce classeur n'a pas pu être affiché.</span>
						{downloadUrl && (
							<a
								href={downloadUrl}
								download={name}
								className="flex h-9 items-center gap-1.5 rounded-full bg-neutral-900 px-3 text-[13px] text-white hover:bg-neutral-700"
							>
								<Download size={15} /> Télécharger le fichier
							</a>
						)}
					</>
				)}
			</div>
		);
	}

	return (
		<div aria-label={name} className="flex h-full w-full flex-col overflow-hidden rounded-k bg-white text-neutral-900 shadow-2xl">
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-[12px] text-neutral-600">
				<span>
					{table.totalRows.toLocaleString("fr-CA")} ligne{table.totalRows > 1 ? "s" : ""} · {table.columns} colonne
					{table.columns > 1 ? "s" : ""}
					{sheets.length > 1 ? ` · ${sheets.length} feuilles` : ""}
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{table.columns > 0 ? (
					<DataTable table={table} downloadUrl={downloadUrl} />
				) : (
					<div className="p-6 text-center text-[14px] text-neutral-500">Feuille vide.</div>
				)}
			</div>
			{sheets.length > 1 && (
				<div role="tablist" aria-label="Feuilles du classeur" className="flex shrink-0 gap-1 overflow-x-auto border-t border-neutral-200 bg-neutral-100 px-2 py-1.5">
					{sheets.map((s, i) => (
						<button
							key={s.name}
							type="button"
							role="tab"
							aria-selected={i === active}
							onClick={() => setActive(i)}
							className={`shrink-0 rounded-md px-3 py-1 text-[12px] whitespace-nowrap transition-colors ${i === active ? "bg-white font-semibold text-neutral-900 shadow-sm" : "text-neutral-600 hover:bg-neutral-200"}`}
						>
							{s.name}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
