"use client";
// ss2i : apercu d'une piece jointe texte ou CSV dans la visionneuse (Samuel le 18/11/2026 :
// un CSV s'ouvrait sur une page blanche). Les octets viennent de notre origine
// (/api/attachments/<id>?mode=content), sont decodes ici et rendus par React, jamais
// interpretes : un CSV en tableau (separateur et encodage detectes), le reste en texte.
import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import DataTable from "@/components/k/data-table";
import { buildTable, decodeText, detectDelimiter, MAX_TABLE_ROWS, parseCsv } from "@/lib/text-preview";

const DELIM_LABEL: Record<string, string> = { ";": "point-virgule", ",": "virgule", "\t": "tabulation", "|": "barre verticale" };

type Loaded = { text: string; encoding: string };

export default function TextPreview({
	url,
	name,
	tabular,
	downloadUrl,
}: {
	url: string;
	name: string;
	tabular: boolean;
	downloadUrl?: string;
}) {
	const [state, setState] = useState<"loading" | "ready" | "error">("loading");
	const [loaded, setLoaded] = useState<Loaded | null>(null);
	const [asTable, setAsTable] = useState(tabular);

	useEffect(() => {
		const controller = new AbortController();
		setState("loading");
		setLoaded(null);
		(async () => {
			try {
				const response = await fetch(url, { signal: controller.signal, credentials: "same-origin" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const bytes = new Uint8Array(await response.arrayBuffer());
				if (controller.signal.aborted) return;
				setLoaded(decodeText(bytes));
				setState("ready");
			} catch (error) {
				if (controller.signal.aborted) return;
				console.warn("[courrier] apercu texte impossible", error);
				setState("error");
			}
		})();
		return () => controller.abort();
	}, [url]);

	const table = useMemo(() => {
		if (!loaded || !tabular) return null;
		const delimiter = detectDelimiter(loaded.text);
		const parsed = parseCsv(loaded.text, delimiter, MAX_TABLE_ROWS + 1);
		return { delimiter, ...buildTable(parsed.rows, parsed.totalRows) };
	}, [loaded, tabular]);

	const plain = useMemo(() => {
		if (!loaded) return "";
		// JSON sur une ligne : remis en forme pour etre lisible.
		if (/\.json$/i.test(name)) {
			try {
				return JSON.stringify(JSON.parse(loaded.text), null, 2);
			} catch {}
		}
		return loaded.text;
	}, [loaded, name]);

	if (state === "loading") {
		return (
			<div className="flex items-center gap-2 text-[14px] text-white/80">
				<Loader2 size={18} className="animate-spin" /> Préparation de l'aperçu…
			</div>
		);
	}
	if (state === "error" || !loaded) {
		return (
			<div className="flex flex-col items-center gap-3 px-6 text-center text-[14px] text-white/85">
				<span>L'aperçu de ce fichier n'a pas pu être affiché.</span>
				{downloadUrl && (
					<a href={downloadUrl} className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 hover:bg-white/25">
						<Download size={15} /> Télécharger
					</a>
				)}
			</div>
		);
	}

	const lineCount = loaded.text.split(/\r\n|\r|\n/).length;
	const tab = (active: boolean) =>
		`rounded-md px-2.5 py-1 transition-colors ${active ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-200"}`;

	return (
		<div
			aria-label={name}
			className="flex h-full w-full flex-col overflow-hidden rounded-k bg-white text-neutral-900 shadow-2xl"
		>
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-[12px] text-neutral-600">
				{table && asTable ? (
					<span>
						{table.totalRows.toLocaleString("fr-CA")} ligne{table.totalRows > 1 ? "s" : ""} · {table.columns} colonne
						{table.columns > 1 ? "s" : ""} · séparateur {DELIM_LABEL[table.delimiter]} · {loaded.encoding}
					</span>
				) : (
					<span>
						{lineCount.toLocaleString("fr-CA")} ligne{lineCount > 1 ? "s" : ""} · {loaded.encoding}
					</span>
				)}
				{table && (
					<div className="ml-auto flex items-center gap-1 rounded-lg bg-neutral-100 p-0.5">
						<button type="button" className={tab(asTable)} onClick={() => setAsTable(true)}>
							Tableau
						</button>
						<button type="button" className={tab(!asTable)} onClick={() => setAsTable(false)}>
							Texte brut
						</button>
					</div>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{table && asTable ? (
					<DataTable table={table} downloadUrl={downloadUrl} />
				) : (
					<pre className="min-w-max p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">{plain}</pre>
				)}
			</div>
		</div>
	);
}
