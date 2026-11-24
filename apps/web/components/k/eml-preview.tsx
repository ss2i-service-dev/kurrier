"use client";
// ss2i : apercu d'un mail joint (.eml) dans la visionneuse (Hugo le 24/11/2026). Le serveur le
// decode (/api/attachments/<id>?mode=message, lib/eml-parse.ts) ; le corps passe par le lecteur
// des mails (EmailViewer : DOMPurify, images distantes bloquees, images inline resolues), et
// ses pieces jointes se telechargent une a une (?mode=part&part=N).
import { useEffect, useMemo, useState } from "react";
import { Download, Loader2, Paperclip } from "lucide-react";
import EmailViewer from "@/components/mailbox/default/email-viewer";
import { formatBytes } from "@/components/k/format";
import { emlPartLink, type EmlAddressField, type EmlPreviewData } from "@/lib/eml-preview";

function people(field: EmlAddressField) {
	return (field?.value ?? [])
		.map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.name || a.address || ""))
		.filter(Boolean)
		.join(", ");
}

function formatDate(iso: string | null) {
	if (!iso) return "";
	return new Date(iso).toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short" });
}

export default function EmlPreview({
	url,
	attachmentId,
	name,
	downloadUrl,
}: {
	url: string;
	attachmentId: string;
	name: string;
	downloadUrl?: string;
}) {
	const [data, setData] = useState<EmlPreviewData | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();
		setData(null);
		setError(null);
		(async () => {
			try {
				const response = await fetch(url, { signal: controller.signal, credentials: "same-origin" });
				const body = await response.json().catch(() => null);
				if (controller.signal.aborted) return;
				if (!response.ok || !body || body.error) throw new Error(body?.error || "Ce mail n'a pas pu être lu.");
				setData(body);
			} catch (e) {
				if (controller.signal.aborted) return;
				setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => controller.abort();
	}, [url]);

	// Objet stable : EmailViewer redessine le corps a chaque changement de message.
	const message = useMemo(
		() =>
			data
				? ({ id: attachmentId, subject: data.subject, html: data.html, text: data.text, from: data.from, to: data.to, cc: data.cc } as any)
				: null,
		[data, attachmentId],
	);

	if (error) {
		return (
			<div className="flex flex-col items-center gap-3 px-6 text-center text-[14px] text-white/85">
				<span>{error}</span>
				{downloadUrl && (
					<a href={downloadUrl} className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 hover:bg-white/25">
						<Download size={15} /> Télécharger
					</a>
				)}
			</div>
		);
	}
	if (!data || !message) {
		return (
			<div className="flex items-center gap-2 text-[14px] text-white/80">
				<Loader2 size={18} className="animate-spin" /> Lecture du mail…
			</div>
		);
	}

	const rows: [string, string][] = [
		["De", people(data.from)],
		["À", people(data.to)],
		["Cc", people(data.cc)],
		["Répondre à", people(data.replyTo)],
		["Date", formatDate(data.date)],
	];

	return (
		<div aria-label={name} className="flex h-full w-full max-w-[960px] flex-col overflow-hidden rounded-k bg-white text-neutral-900 shadow-2xl">
			<div className="shrink-0 border-b border-neutral-200 bg-neutral-50 px-5 py-3">
				<div className="mb-1.5 text-[17px] font-semibold leading-snug">{data.subject || "(sans objet)"}</div>
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
					{rows
						.filter(([, v]) => v)
						.map(([label, value]) => (
							<div key={label} className="contents">
								<dt className="text-neutral-500">{label}</dt>
								<dd className="min-w-0 break-words text-neutral-800">{value}</dd>
							</div>
						))}
				</dl>
			</div>
			<div className="min-h-0 flex-1 overflow-auto px-5 py-4">
				<EmailViewer message={message} cidUrls={data.cidUrls} />
			</div>
			{data.attachments.length > 0 && (
				<div className="shrink-0 border-t border-neutral-200 bg-neutral-50 px-5 py-2.5">
					<div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-neutral-500">
						<Paperclip size={13} />
						{data.attachments.length} pièce{data.attachments.length > 1 ? "s" : ""} jointe{data.attachments.length > 1 ? "s" : ""}
					</div>
					<div className="flex flex-wrap gap-2">
						{data.attachments.map((a) => (
							<a
								key={a.index}
								href={emlPartLink(attachmentId, a.index)}
								download={a.filename}
								title={`Télécharger ${a.filename}`}
								className="inline-flex max-w-[280px] items-center gap-2 rounded-k border border-neutral-200 bg-white px-2.5 py-1.5 text-[13px] hover:border-neutral-400"
							>
								<Download size={14} className="shrink-0 text-neutral-500" />
								<span className="truncate">{a.filename}</span>
								<span className="shrink-0 text-[12px] text-neutral-500">{formatBytes(a.size)}</span>
							</a>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
