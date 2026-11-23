"use client";
// Preview of a received zip in the viewer: the list of the files it contains, as a tree.
// Nothing is decompressed: the server reads the central directory by S3 ranges
// (/api/attachments/<id>?mode=listing, lib/zip-listing.ts).
import { useEffect, useMemo, useState } from "react";
import { Download, File, Folder, Loader2, Lock } from "lucide-react";
import { formatBytes } from "@/components/k/format";
import type { ZipEntry } from "@/lib/zip-listing";

type Listing = { entries: ZipEntry[]; total: number; truncated: boolean; archiveSize: number };
type Row = { path: string; name: string; depth: number; dir: boolean; size: number; modified: string | null; encrypted: boolean };

// Implicit folders (file "a/b/c.txt" without an "a/" entry) are recreated, then everything is
// sorted folder by folder, subfolders first.
function toRows(entries: ZipEntry[]): Row[] {
	const byPath = new Map<string, Row>();
	for (const e of entries) {
		const clean = e.path.replace(/\\/g, "/").replace(/\/+$/, "");
		if (!clean || clean.startsWith("__MACOSX") || /(^|\/)\.DS_Store$/.test(clean)) continue;
		const parts = clean.split("/");
		for (let i = 1; i < parts.length; i++) {
			const p = parts.slice(0, i).join("/");
			if (!byPath.has(p)) byPath.set(p, { path: p, name: parts[i - 1], depth: i - 1, dir: true, size: 0, modified: null, encrypted: false });
		}
		const existing = byPath.get(clean);
		byPath.set(clean, {
			path: clean,
			name: parts[parts.length - 1],
			depth: parts.length - 1,
			dir: e.dir || !!existing?.dir,
			size: e.size,
			modified: e.modified ?? existing?.modified ?? null,
			encrypted: e.encrypted,
		});
	}
	const key = (r: Row) =>
		r.path
			.split("/")
			.map((part, i, all) => (i < all.length - 1 || r.dir ? `0${part.toLowerCase()}` : `1${part.toLowerCase()}`))
			.join("/");
	return [...byPath.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

function formatDate(iso: string | null) {
	if (!iso) return "";
	const [d, t] = iso.split("T");
	return `${d} ${t.slice(0, 5)}`;
}

export default function ZipPreview({ url, name, downloadUrl }: { url: string; name: string; downloadUrl?: string }) {
	const [listing, setListing] = useState<Listing | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setListing(null);
		setError(null);
		(async () => {
			try {
				const response = await fetch(url, { signal: controller.signal, credentials: "same-origin" });
				const body = await response.json().catch(() => null);
				if (controller.signal.aborted) return;
				if (!response.ok || !body?.entries) throw new Error(body?.error || "The list of files could not be read.");
				setListing(body);
			} catch (e) {
				if (controller.signal.aborted) return;
				setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => controller.abort();
	}, [url]);

	const rows = useMemo(() => (listing ? toRows(listing.entries) : []), [listing]);
	const files = rows.filter((r) => !r.dir);
	const totalSize = files.reduce((s, r) => s + r.size, 0);

	if (error) {
		return (
			<div className="flex flex-col items-center gap-3 px-6 text-center text-[14px] text-white/85">
				<span>{error}</span>
				{downloadUrl && (
					<a href={downloadUrl} className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 hover:bg-white/25">
						<Download size={15} /> Download
					</a>
				)}
			</div>
		);
	}
	if (!listing) {
		return (
			<div className="flex items-center gap-2 text-[14px] text-white/80">
				<Loader2 size={18} className="animate-spin" /> Reading the content of the archive…
			</div>
		);
	}

	return (
		<div aria-label={name} className="flex h-full w-full flex-col overflow-hidden rounded-k bg-white text-neutral-900 shadow-2xl">
			<div className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-[12px] text-neutral-600">
				<span>
					{files.length.toLocaleString()} file{files.length > 1 ? "s" : ""} · {formatBytes(totalSize)} uncompressed ·
					archive of {formatBytes(listing.archiveSize)}
				</span>
				{rows.some((r) => r.encrypted) && (
					<span className="inline-flex items-center gap-1 text-amber-700">
						<Lock size={12} /> password protected
					</span>
				)}
			</div>
			<div className="min-h-0 flex-1 overflow-auto">
				{rows.length === 0 ? (
					<div className="p-6 text-center text-[14px] text-neutral-500">Empty archive.</div>
				) : (
					<table className="w-full text-[13px] tabular-nums">
						<thead className="sticky top-0 bg-neutral-100 text-left text-[12px] text-neutral-500">
							<tr>
								<th className="px-4 py-1.5 font-medium">Name</th>
								<th className="w-28 px-3 py-1.5 text-right font-medium">Size</th>
								<th className="w-36 px-4 py-1.5 font-medium">Modified</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.path} className="border-b border-neutral-100 hover:bg-amber-50">
									<td className="py-1 pr-3" style={{ paddingLeft: `${16 + r.depth * 18}px` }}>
										<span className="inline-flex items-center gap-2 break-all" title={r.path}>
											{r.dir ? (
												<Folder size={15} className="shrink-0 fill-amber-200 text-amber-600" />
											) : (
												<File size={15} className="shrink-0 text-neutral-400" />
											)}
											<span className={r.dir ? "font-medium" : ""}>{r.name}</span>
											{r.encrypted && <Lock size={12} className="shrink-0 text-amber-700" aria-label="protected" />}
										</span>
									</td>
									<td className="px-3 py-1 text-right text-neutral-600">{r.dir ? "" : formatBytes(r.size)}</td>
									<td className="px-4 py-1 whitespace-nowrap text-neutral-500">{formatDate(r.modified)}</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{listing.truncated && (
					<div className="border-t border-neutral-200 px-4 py-3 text-[13px] text-neutral-600">
						First {listing.entries.length.toLocaleString()} entries shown out of {listing.total.toLocaleString()}.
					</div>
				)}
			</div>
		</div>
	);
}
