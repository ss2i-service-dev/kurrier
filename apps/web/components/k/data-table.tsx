"use client";
// ss2i : tableau d'apercu (CSV, feuille de classeur) : en-tetes fixes, numero de ligne fixe,
// colonnes numeriques a droite. Prend toute la largeur de la visionneuse ; le defilement
// horizontal n'apparait que si les colonnes ne tiennent vraiment pas.
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
						// biome-ignore lint/suspicious/noArrayIndexKey: lignes d'un fichier fige
						<tr key={r} className="even:bg-neutral-50 hover:bg-amber-50">
							<td className="sticky left-0 border-r border-b border-neutral-200 bg-inherit px-2 py-1 text-right text-neutral-400 select-none">
								{r + 1}
							</td>
							{Array.from({ length: table.columns }, (_, c) => (
								<td
									// biome-ignore lint/suspicious/noArrayIndexKey: colonnes d'un fichier fige
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
					{table.body.length.toLocaleString("fr-CA")} premières lignes affichées sur {table.totalRows.toLocaleString("fr-CA")}.
					{downloadUrl && (
						<a href={downloadUrl} className="ml-2 font-medium text-blue-700 underline">
							Télécharger le fichier complet
						</a>
					)}
				</div>
			)}
		</>
	);
}
