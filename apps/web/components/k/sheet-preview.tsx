"use client";
// Preview of an xls, xlsx or ods workbook in the viewer. Bytes from
// /api/attachments/<id>?mode=content, read here by SheetJS (imported on demand,
// lib/sheet-preview.ts) and rendered by React like a CSV: one tab per sheet, never any HTML
// produced by the library.
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
				console.warn("[mail] workbook preview failed", error);
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
						<Loader2 size={18} className="animate-spin" /> Reading the workbook…
					</span>
				) : (
					<>
						<span>The preview of this workbook could not be displayed.</span>
						{downloadUrl && (
							<a
								href={downloadUrl}
								download={name}
								className="flex h-9 items-center gap-1.5 rounded-full bg-neutral-900 px-3 text-[13px] text-white hover:bg-neutral-700"
							>
								<Download size={15} /> Download the file
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
					{table.totalRows.toLocaleString()} row{table.totalRows > 1 ? "s" : ""} · {table.columns} column
					{table.columns > 1 ? "s" : ""}
					{sheets.length > 1 ? ` · ${sheets.length} sheets` : ""}
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{table.columns > 0 ? (
					<DataTable table={table} downloadUrl={downloadUrl} />
				) : (
					<div className="p-6 text-center text-[14px] text-neutral-500">Empty sheet.</div>
				)}
			</div>
			{sheets.length > 1 && (
				<div role="tablist" aria-label="Sheets of the workbook" className="flex shrink-0 gap-1 overflow-x-auto border-t border-neutral-200 bg-neutral-100 px-2 py-1.5">
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
