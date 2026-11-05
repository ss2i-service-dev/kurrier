// Shared building blocks of the Platform section (modern interface): page with
// title, cards, status badges, list rows, indicators.
import React from "react";
import Link from "next/link";
import { KSectionHeader } from "@/components/k/section";

/** Section page: header (title, subtitle, actions) + scrolling area. */
export function KPage({
	title,
	subtitle,
	actions,
	children,
	wide = false,
}: {
	title: React.ReactNode;
	subtitle?: React.ReactNode;
	actions?: React.ReactNode;
	children: React.ReactNode;
	wide?: boolean;
}) {
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<KSectionHeader title={title} subtitle={subtitle} actions={actions} />
			<div className="k-scroll min-h-0 flex-1 overflow-y-auto border-t border-k-line bg-k-surface-2/60">
				<div className={`k-fade-in mx-auto space-y-4 px-4 py-5 md:px-8 md:py-6 ${wide ? "max-w-5xl" : "max-w-4xl"}`}>
					{children}
				</div>
			</div>
		</div>
	);
}

/** Card: title, description, actions on the right, content, optional footer. */
export function KCard({
	title,
	description,
	actions,
	children,
	footer,
	flush = false,
	className = "",
}: {
	title?: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	children?: React.ReactNode;
	footer?: React.ReactNode;
	flush?: boolean;
	className?: string;
}) {
	return (
		<section className={`rounded-k-pane border border-k-line bg-k-surface shadow-k-pane ${className}`}>
			{(title || actions) && (
				<div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4">
					<div className="min-w-[14rem] flex-1">
						{title && <h2 className="text-[15px] font-semibold tracking-tight text-k-ink">{title}</h2>}
						{description && <p className="mt-1 text-[13px] leading-relaxed text-k-ink-2">{description}</p>}
					</div>
					{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
				</div>
			)}
			{children != null && <div className={flush ? "mt-3" : "px-5 py-4"}>{children}</div>}
			{footer && <div className="border-t border-k-line px-5 py-3">{footer}</div>}
		</section>
	);
}

type Tone = "ok" | "warn" | "danger" | "neutral" | "accent";
const TONES: Record<Tone, string> = {
	ok: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
	warn: "bg-k-warn-soft text-k-warn",
	danger: "bg-k-danger-soft text-k-danger",
	neutral: "bg-k-hover text-k-ink-2",
	accent: "bg-k-accent-soft text-k-accent-soft-ink",
};

/** Status badge (verified, not verified, default...). */
export function KBadge({
	tone = "neutral",
	icon,
	children,
}: {
	tone?: Tone;
	icon?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<span
			className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-5 [&_svg]:size-3 ${TONES[tone]}`}
		>
			{icon}
			{children}
		</span>
	);
}

/** List row inside a `flush` card: content on the left, actions on the right. */
export function KRow({
	icon,
	title,
	meta,
	badges,
	actions,
}: {
	icon?: React.ReactNode;
	title: React.ReactNode;
	meta?: React.ReactNode;
	badges?: React.ReactNode;
	actions?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-3 border-t border-k-line px-5 py-3.5 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex min-w-0 items-start gap-3">
				{icon && (
					<div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-k-sm bg-k-hover text-k-ink-2 [&_svg]:size-4">
						{icon}
					</div>
				)}
				<div className="min-w-0">
					<div className="truncate text-[14px] font-medium text-k-ink">{title}</div>
					{meta && <div className="mt-0.5 break-words text-[12.5px] text-k-ink-3">{meta}</div>}
					{badges && <div className="mt-2 flex flex-wrap items-center gap-1.5">{badges}</div>}
				</div>
			</div>
			{actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
		</div>
	);
}

/** Empty state of a list. */
export function KEmpty({
	icon,
	title,
	text,
	action,
}: {
	icon?: React.ReactNode;
	title: string;
	text?: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
			{icon && (
				<div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-k-hover text-k-ink-3 [&_svg]:size-5">
					{icon}
				</div>
			)}
			<p className="text-[14px] font-medium text-k-ink">{title}</p>
			{text && <p className="max-w-sm text-[13px] text-k-ink-3">{text}</p>}
			{action && <div className="mt-2">{action}</div>}
		</div>
	);
}

/** Numeric indicator. */
export function KStat({
	icon,
	label,
	value,
	hint,
}: {
	icon?: React.ReactNode;
	label: string;
	value: React.ReactNode;
	hint?: React.ReactNode;
}) {
	return (
		<div className="rounded-k-pane border border-k-line bg-k-surface p-4 shadow-k-pane">
			<div className="flex items-center justify-between gap-2">
				<span className="text-[12.5px] font-medium text-k-ink-3">{label}</span>
				{icon && <span className="text-k-ink-3 [&_svg]:size-4">{icon}</span>}
			</div>
			<div className="mt-2 text-[24px] font-semibold leading-none tracking-tight tabular-nums text-k-ink">{value}</div>
			{hint && <div className="mt-1.5 text-[12px] text-k-ink-3">{hint}</div>}
		</div>
	);
}

/** Label / value pairs (inside a card). */
export function KFacts({ rows }: { rows: [string, React.ReactNode][] }) {
	return (
		<dl className="divide-y divide-k-line">
			{rows.map(([label, value]) => (
				<div key={label} className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0">
					<dt className="text-[13px] text-k-ink-2">{label}</dt>
					<dd className="text-[13px] font-medium tabular-nums text-k-ink">{value}</dd>
				</div>
			))}
		</dl>
	);
}

/** Plain progress bar. */
export function KMeter({ value, tone = "accent" }: { value: number; tone?: "accent" | "danger" }) {
	const pct = Math.max(0, Math.min(100, value));
	return (
		<div className="h-1.5 w-full overflow-hidden rounded-full bg-k-hover">
			<div
				className={`h-full rounded-full ${tone === "danger" ? "bg-k-danger" : "bg-k-accent"}`}
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}

export function fmtBytes(value: unknown) {
	const n = Number(value || 0);
	if (!Number.isFinite(n) || n <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = n;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	const digits = unit === 0 ? 0 : size < 10 ? 1 : 0;
	return `${size.toFixed(digits)} ${units[unit]}`;
}

export function fmtNumber(value: unknown) {
	return Number(value || 0).toLocaleString(undefined);
}

/** Date and time in the browser locale. */
export function fmtDateTime(input?: Date | string | null) {
	if (!input) return "-";
	const d = new Date(input);
	if (Number.isNaN(d.getTime())) return "-";
	return d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Readable labels of the providers' configuration variables. */
export const ENV_LABELS: Record<string, string> = {
	SES_ACCESS_KEY_ID: "Access key ID",
	SES_SECRET_ACCESS_KEY: "Secret access key",
	SES_REGION: "Region",
	SENDGRID_API_KEY: "API key",
	MAILGUN_API_KEY: "API key",
	POSTMARK_SERVER_TOKEN: "Server token",
	POSTMARK_ACCOUNT_TOKEN: "Account token",
	S3_ACCESS_KEY_ID: "Access key ID",
	S3_SECRET_ACCESS_KEY: "Secret access key",
	S3_REGION: "Region",
	SMTP_HOST: "SMTP server",
	SMTP_PORT: "Port SMTP",
	SMTP_USERNAME: "SMTP username",
	SMTP_PASSWORD: "SMTP password",
	SMTP_SECURE: "Implicit TLS",
	SMTP_POOL: "Connection pool",
	IMAP_HOST: "IMAP server",
	IMAP_PORT: "Port IMAP",
	IMAP_USERNAME: "IMAP username",
	IMAP_PASSWORD: "IMAP password",
	IMAP_SECURE: "Implicit TLS",
};

/** Field label: readable text followed by the technical variable in a muted style. */
export function envLabel(key: string) {
	return (
		<span className="inline-flex flex-wrap items-baseline gap-x-1.5">
			<span>{ENV_LABELS[key] ?? key}</span>
			<code className="text-[11px] font-normal text-k-ink-3">{key}</code>
		</span>
	);
}

/** Button-styled link, usable in a server component. */
export function KLinkButton({
	href,
	primary = false,
	children,
}: {
	href: string;
	primary?: boolean;
	children: React.ReactNode;
}) {
	return (
		<Link
			href={href}
			className={`k-focus inline-flex h-[30px] items-center rounded-k px-3 text-[12.5px] font-medium transition-colors ${
				primary
					? "bg-k-accent text-k-accent-ink hover:bg-k-accent-hover"
					: "border border-k-line-strong bg-k-surface text-k-ink hover:bg-k-hover"
			}`}
		>
			{children}
		</Link>
	);
}
