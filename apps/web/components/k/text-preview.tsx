"use client";
// Preview of a text or CSV attachment in the viewer (a CSV used to open on a blank page).
// The bytes come from our origin (/api/attachments/<id>?mode=content), are decoded here
// and rendered by React, never interpreted: a table for a CSV (delimiter and encoding
// detected), text otherwise.
import { useEffect, useMemo, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { decodeText, detectDelimiter, parseCsv } from "@/lib/text-preview";

// Beyond this, rendering the table slows the browser down: the rest comes with the download.
const MAX_ROWS = 5000;
const NUMBER = /^[-+]?[\d\s  .,]*\d[\d\s  .,]*\s?(%|€|\$|£|EUR|CAD|USD)?$/i;

const DELIM_LABEL: Record<string, string> = { ";": "semicolon", ",": "comma", "\t": "tab", "|": "vertical bar" };

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
				console.warn("[mail] text preview failed", error);
				setState("error");
			}
		})();
		return () => controller.abort();
	}, [url]);

	const table = useMemo(() => {
		if (!loaded || !tabular) return null;
		const delimiter = detectDelimiter(loaded.text);
		const parsed = parseCsv(loaded.text, delimiter, MAX_ROWS + 1);
		const columns = parsed.rows.reduce((m, r) => Math.max(m, r.length), 0);
		const [header = [], ...body] = parsed.rows;
		// A column is numeric if all its non-empty cells are: right-aligned.
		const numeric = Array.from({ length: columns }, (_, c) => {
			const values = body.map((r) => (r[c] ?? "").trim()).filter(Boolean);
			return values.length > 0 && values.every((v) => NUMBER.test(v));
		});
		// Long text column (labels): wrapped with a minimum width; the others (dates,
		// codes, amounts) stay on one line.
		const long = Array.from({ length: columns }, (_, c) => body.some((r) => (r[c] ?? "").length > 40));
		return { delimiter, header, body: body.slice(0, MAX_ROWS), totalRows: parsed.totalRows - 1, columns, numeric, long };
	}, [loaded, tabular]);

	const plain = useMemo(() => {
		if (!loaded) return "";
		// JSON on one line: reformatted to be readable.
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
				<Loader2 size={18} className="animate-spin" /> Preparing the preview…
			</div>
		);
	}
	if (state === "error" || !loaded) {
		return (
			<div className="flex flex-col items-center gap-3 px-6 text-center text-[14px] text-white/85">
				<span>The preview of this file could not be displayed.</span>
				{downloadUrl && (
					<a href={downloadUrl} className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 hover:bg-white/25">
						<Download size={15} /> Download
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
			className="flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-k bg-white text-neutral-900 shadow-2xl"
		>
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-[12px] text-neutral-600">
				{table && asTable ? (
					<span>
						{table.totalRows.toLocaleString()} row{table.totalRows > 1 ? "s" : ""} · {table.columns} column
						{table.columns > 1 ? "s" : ""} · {DELIM_LABEL[table.delimiter]} delimiter · {loaded.encoding}
					</span>
				) : (
					<span>
						{lineCount.toLocaleString()} line{lineCount > 1 ? "s" : ""} · {loaded.encoding}
					</span>
				)}
				{table && (
					<div className="ml-auto flex items-center gap-1 rounded-lg bg-neutral-100 p-0.5">
						<button type="button" className={tab(asTable)} onClick={() => setAsTable(true)}>
							Table
						</button>
						<button type="button" className={tab(!asTable)} onClick={() => setAsTable(false)}>
							Plain text
						</button>
					</div>
				)}
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{table && asTable ? (
					<table className="min-w-full border-separate border-spacing-0 text-[13px] tabular-nums">
						<thead>
							<tr>
								<th className="sticky top-0 left-0 z-20 border-r border-b border-neutral-300 bg-neutral-100 px-2 py-1.5 text-right font-normal text-neutral-400">
									#
								</th>
								{Array.from({ length: table.columns }, (_, c) => (
									<th
										key={c}
										className={`sticky top-0 z-10 border-r border-b border-neutral-300 bg-neutral-100 px-3 py-1.5 font-semibold ${table.long[c] ? "min-w-[18rem] max-w-[32rem] whitespace-pre-wrap" : "whitespace-nowrap"} ${table.numeric[c] ? "text-right" : "text-left"}`}
									>
										{table.header[c] ?? ""}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{table.body.map((row, r) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: rows of a frozen file
								<tr key={r} className="even:bg-neutral-50 hover:bg-amber-50">
									<td className="sticky left-0 border-r border-b border-neutral-200 bg-inherit px-2 py-1 text-right text-neutral-400 select-none">
										{r + 1}
									</td>
									{Array.from({ length: table.columns }, (_, c) => (
										<td
											// biome-ignore lint/suspicious/noArrayIndexKey: columns of a frozen file
											key={c}
											className={`border-r border-b border-neutral-200 px-3 py-1 align-top ${table.long[c] ? "min-w-[18rem] max-w-[32rem] whitespace-pre-wrap" : "whitespace-nowrap"} ${table.numeric[c] ? "text-right" : ""}`}
										>
											{row[c] ?? ""}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				) : (
					<pre className="min-w-max p-4 font-mono text-[13px] leading-relaxed whitespace-pre-wrap break-words">{plain}</pre>
				)}
				{table && asTable && table.totalRows > table.body.length && (
					<div className="border-t border-neutral-200 px-4 py-3 text-[13px] text-neutral-600">
						First {table.body.length.toLocaleString()} rows shown out of {table.totalRows.toLocaleString()}.
						{downloadUrl && (
							<a href={downloadUrl} className="ml-2 font-medium text-blue-700 underline">
								Download the complete file
							</a>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
