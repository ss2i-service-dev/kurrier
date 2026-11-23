"use client";
// Preview table (CSV, workbook sheet): fixed headers, fixed row number, numeric columns on the
// right. Takes the whole width of the viewer; horizontal scrolling only appears when the
// columns really do not fit.
import type { PreviewTable } from "@/lib/text-preview";

export default function DataTable({ table, downloadUrl }: { table: PreviewTable; downloadUrl?: string }) {
	return (
		<>
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
			{table.totalRows > table.body.length && (
				<div className="border-t border-neutral-200 px-4 py-3 text-[13px] text-neutral-600">
					First {table.body.length.toLocaleString()} rows shown out of {table.totalRows.toLocaleString()}.
					{downloadUrl && (
						<a href={downloadUrl} className="ml-2 font-medium text-blue-700 underline">
							Download the complete file
						</a>
					)}
				</div>
			)}
		</>
	);
}
