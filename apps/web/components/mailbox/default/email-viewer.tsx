// @ts-nocheck
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import type { MessageEntity } from "@db";
import { Button } from "@mantine/core";
import { Ellipsis, Image as ImageIcon, ImageOff } from "lucide-react";
import { adaptEmailToDark } from "@/components/k/dark-email";
import { setRemoteImagesForContact } from "@/lib/actions/contact-images";
import { toast } from "sonner";

import { joinSurrogateEntities } from "@common/html-entities";

// Shared with the editable quote (reply-quote-editor) so it renders like the reader.
export const BASE_CSS = `
:host {
  /* Reading area always light, like Gmail: HTML mails set their own text
     colors, a dark background would make them unreadable. */
  --bg: #ffffff;
  --text: #0f172a;      /* slate-900 */
  --muted: #475569;     /* slate-600 */
  --border: #e5e7eb;    /* gray-200 */
  --quote-bg: #f8fafc;  /* slate-50 */
  --quote-bar: #cbd5e1; /* slate-300 */
  --link: #2563eb;
  color: var(--text);
  color-scheme: light;
  display: block;
}

.email-root {
  font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji","Segoe UI Emoji","Segoe UI Symbol";
  background: var(--bg);
  color: var(--text);
   /* break-word and not anywhere (nor word-break: break-word, which equals
      anywhere in Chrome): anywhere drops the minimum width of a cell to one
      letter, so the table layout algorithm distributes the width badly and
      breaks words in the middle. break-word only breaks a word that really
      overflows. A table that is too wide scrolls instead of being clipped. */
   overflow-wrap: break-word;
   white-space: normal !important; /* override inline nowrap */
   overflow-x: auto;
}


.email-root * {
  overflow-wrap: break-word !important; /* enforce wrapping for nested tags */
  white-space: normal !important;   /* neutralize inline nowrap */
}

/* Plain-text mail, original formatting preserved */
.email-root .kurrier-plain {
  white-space: pre-wrap !important;
  padding: 6px;
  line-height: 1.5;
}

.email-root p { margin: 0 0 .85em; }
.email-root p:last-child { margin-bottom: 0; }

.email-root h1, .email-root h2, .email-root h3,
.email-root h4, .email-root h5, .email-root h6 {
  margin: 1.2em 0 .6em; line-height: 1.25; font-weight: 600;
}
.email-root h1 { font-size: 1.375rem; }
.email-root h2 { font-size: 1.25rem; }
.email-root h3 { font-size: 1.125rem; }

.email-root ul, .email-root ol { padding-left: 1.25rem; margin: .5rem 0 .85rem; }
.email-root li { margin: .25rem 0; }

.email-root a { color: var(--link); text-decoration: none; }
.email-root a:hover { text-decoration: underline; }

/* max-width without !important: an inline style in the mail (a logo with
   width:100%;max-width:250px) must win, otherwise the image stretches to the
   full width of the reading area. */
.email-root img, .email-root video, .email-root canvas, .email-root svg {
  max-width: 100%; height: auto !important;
}

/* Don’t style tables/cells; just prevent overflow */
.email-root table { max-width: 85vw; }
.email-root .table-scroll { overflow-x: auto; }

/* Pre/code */
.email-root pre, .email-root code, .email-root kbd, .email-root samp {
  font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
}
.email-root pre { padding: .75rem; background: #0f172a0d; border-radius: .375rem; overflow: auto; }

/* Softer <hr>, and hide a leading one */
.email-root hr {
  border: 0; border-top: 1px solid var(--border);
  margin: 1rem 0; height: 1px; opacity: .7;
}
.email-root > hr:first-child { display: none; }

/* Quoted/reply blocks */
.email-root blockquote,
.email-root blockquote[type="cite"],
.email-root .gmail_quote,
.email-root .gmail_quote_container blockquote,
.email-root .moz-cite-prefix + blockquote,
.email-root blockquote blockquote {
  font-size: 0.92rem !important;
  color: var(--muted) !important;
  background: var(--quote-bg) !important;
  border-left: 3px solid var(--quote-bar) !important;
  margin: .75rem 0 !important;
  padding: .5rem .75rem !important;
}
`;

const QUOTE_HIDE_CSS = `
/* Gmail / generic */
blockquote,
blockquote[type="cite"],
.gmail_quote,
.gmail_quote_container blockquote,
/* Thunderbird */
.moz-cite-prefix + blockquote,
/* Outlook-ish nested reply borders */
div[style*="border-left"][style*="solid"] blockquote {
  display: none !important;
}
`;

// Modern interface (adaptTheme prop). The body takes the theme colors (--k-*
// variables inherited through the shadow DOM) instead of the forced white
// background. In dark mode an HTML mail keeps its colors, adapted one by one
// (components/k/dark-email.ts); no invert filter on the whole mail (it tinted
// images, logos and signatures). Without adaptTheme nothing changes.
const THEME_CSS = `
:host { color-scheme: light dark; }
.email-root.k-theme {
  --bg: transparent;
  --text: var(--k-ink, #1b1a19);
  --muted: var(--k-ink-2, #57534e);
  --border: var(--k-line, #e8e6e1);
  --quote-bg: var(--k-surface-2, #f8f7f5);
  --quote-bar: var(--k-line-strong, #d7d3cc);
  --link: var(--k-accent, #3555d6);
  font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14.5px;
}
/* Dark mode of an HTML mail: no filter, the mail colors are recomputed one
   by one (components/k/dark-email.ts), images untouched. */
.email-root.k-theme.k-dark-html { color-scheme: dark; }
`;

export default function EmailViewer({
	message,
	remoteImagesAllowed = false,
	cidUrls,
	adaptTheme = false,
}: {
	message: MessageEntity;
	remoteImagesAllowed?: boolean;
	// Content-ID (without angle brackets, lowercase) -> signed attachment URL.
	// Resolves inline images left as cid: in the stored HTML.
	cidUrls?: Record<string, string>;
	// Modern interface, body adapted to the theme (see THEME_CSS).
	adaptTheme?: boolean;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const [isDark, setIsDark] = useState(false);
	useEffect(() => {
		if (!adaptTheme) return;
		const html = document.documentElement;
		const sync = () => setIsDark(html.classList.contains("dark"));
		sync();
		const obs = new MutationObserver(sync);
		obs.observe(html, { attributes: true, attributeFilter: ["class"] });
		return () => obs.disconnect();
	}, [adaptTheme]);
	const [hideQuotes, setHideQuotes] = useState(true);

	const [showRemoteImages, setShowRemoteImages] = useState(remoteImagesAllowed);
	const [hasBlockedImages, setHasBlockedImages] = useState(false);
	// Permission stored on the CONTACT (server side, all browsers): shown and
	// reversible, otherwise the "load images" button vanishes without
	// explanation.
	const [alwaysForSender, setAlwaysForSender] = useState(remoteImagesAllowed);
	const [savingPref, setSavingPref] = useState(false);

	function blockRemoteImages(html: string, allowImages: boolean) {
		const doc = new DOMParser().parseFromString(html, "text/html");
		const images = doc.querySelectorAll<HTMLImageElement>("img[src]");
		let blocked = false;

		images.forEach((img) => {
			const src = img.getAttribute("src") || "";

			if (/^cid:/i.test(src)) {
				const key = src.slice(4).replace(/^<|>$/g, "").trim().toLowerCase();
				const url = cidUrls?.[key];
				if (url) img.setAttribute("src", url);
				return;
			}

			if (/^https?:\/\//i.test(src)) {
				blocked = true;

				if (!allowImages) {
					img.setAttribute("data-blocked-src", src);
					img.removeAttribute("src");
					img.setAttribute("alt", img.getAttribute("alt") || "Remote image blocked");
				}
			}
		});

		return {
			html: doc.body.innerHTML,
			blocked,
		};
	}

	const hasQuotes = useMemo(() => {
		const html = message.html || "";
		if (!html.trim()) return false;
		return /<blockquote\b|class=["']gmail_quote|blockquote\s+type=["']cite|class=["']moz-cite-prefix/i.test(
			html,
		);
	}, [message.html]);

	const senderEmail = message?.from?.value?.[0]?.address || "unknown";
	const senderName = message?.from?.value?.[0]?.name || null;

	useEffect(() => {
		setAlwaysForSender(remoteImagesAllowed);
		setShowRemoteImages(remoteImagesAllowed);
	}, [remoteImagesAllowed, senderEmail]);

	// Other already-open messages from the same sender (multi-message thread)
	// follow the preference without a reload.
	useEffect(() => {
		const onPref = (e: Event) => {
			const d = (e as CustomEvent).detail ?? {};
			if (String(d.email).toLowerCase() !== String(senderEmail).toLowerCase()) return;
			setAlwaysForSender(Boolean(d.allow));
			setShowRemoteImages(Boolean(d.allow));
		};
		window.addEventListener("kurrier:remote-images", onPref);
		return () => window.removeEventListener("kurrier:remote-images", onPref);
	}, [senderEmail]);

	const savePreference = async (allow: boolean) => {
		if (!senderEmail || senderEmail === "unknown") {
			// Unreadable sender: nothing to remember, limit it to this message.
			setShowRemoteImages(allow);
			return;
		}
		// Show immediately, saving follows.
		setShowRemoteImages(allow);
		setSavingPref(true);
		try {
			const r = await setRemoteImagesForContact({ email: senderEmail, name: senderName, allow });
			if (r?.success === false) throw new Error(r.error ?? "Failed");
			setAlwaysForSender(allow);
			window.dispatchEvent(new CustomEvent("kurrier:remote-images", { detail: { email: senderEmail, allow } }));
			if (allow && r?.created) toast.success(`${senderEmail} added to your contacts`);
		} catch (e: any) {
			toast.error(e?.message ?? "Could not save the preference");
		} finally {
			setSavingPref(false);
		}
	};
	const allowRemoteImagesForSender = () => savePreference(true);
	const blockRemoteImagesAgain = () => savePreference(false);

	useEffect(() => {
		if (!hostRef.current) return;

		let shadow = hostRef.current.shadowRoot;
		if (!shadow) shadow = hostRef.current.attachShadow({ mode: "open" });

		const rawHtml =
			message.html && message.html.trim()
				? // Outlook emojis as pairs of surrogate references (rendered as garbage otherwise).
					joinSurrogateEntities(message.html)
				: // Plain-text mail: dedicated class to keep line breaks and alignment
					// (the general `white-space: normal !important` rule overrode them),
					// web addresses rendered as links.
					`<div class="kurrier-plain">${(message.text || "No content")
						.toString()
						.replace(
							/[<>&]/g,
							(c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string,
						)
						.replace(
							/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/g,
							(u) => `<a href="${u}">${u}</a>`,
						)}</div>`;

		const sanitized = DOMPurify.sanitize(rawHtml, {
			USE_PROFILES: { html: true },
		});

		const { html: safeHtml, blocked } = blockRemoteImages(
			sanitized,
			showRemoteImages,
		);

		setHasBlockedImages(blocked);

		shadow.innerHTML = `
      <style>${BASE_CSS}${adaptTheme ? THEME_CSS : ""}${hideQuotes ? QUOTE_HIDE_CSS : ""}</style>
      <article class="email-root${adaptTheme ? ` k-theme${isDark && message.html?.trim() ? " k-dark-html" : ""}` : ""}">${safeHtml}</article>
    `;

		const root = shadow.querySelector(".email-root") as HTMLElement | null;
		// A Gmail forward puts the whole forwarded message in .gmail_quote; hiding
		// quotes then left an empty frame. If nothing visible remains, show everything.
		if (
			root &&
			hideQuotes &&
			!root.innerText.trim() &&
			!Array.from(root.querySelectorAll("img")).some((img) => img.offsetParent !== null)
		) {
			setHideQuotes(false);
			return;
		}
		if (root && adaptTheme && isDark && message.html?.trim()) adaptEmailToDark(root);
		if (root) {
			const links = root.querySelectorAll<HTMLAnchorElement>("a[href]");
			links.forEach((a) => {
				a.target = "_blank";
				a.rel = "nofollow noopener noreferrer";
			});
		}
	}, [message.html, message.text, hideQuotes, showRemoteImages, cidUrls, adaptTheme, isDark]);

	return (
		<div
			className={
				adaptTheme
					? "mt-1 overflow-x-hidden"
					: "mb-10 mt-5 overflow-x-hidden rounded-xl border border-neutral-200 bg-white text-neutral-900 px-6 py-5 dark:border-neutral-700"
			}
		>
			{hasBlockedImages && adaptTheme && (
				<KImagesNotice
					blocked={!showRemoteImages}
					always={alwaysForSender}
					sender={senderEmail}
					saving={savingPref}
					onLoad={allowRemoteImagesForSender}
					onStopAuto={blockRemoteImagesAgain}
					onHide={() => setShowRemoteImages(false)}
				/>
			)}
			{hasBlockedImages && !adaptTheme && (
				<div className="mb-4 flex flex-wrap items-center gap-2 rounded-md bg-neutral-100 px-3 py-2 text-xs text-neutral-600">
					{!showRemoteImages ? (
						<>
							<span>{"Remote images are blocked."}</span>
							{/* Loading once = loading always for this sender. */}
							<Button size="xs" variant="default" loading={savingPref} onClick={allowRemoteImagesForSender} title={`Also loads them automatically in future messages from ${senderEmail}`}>
								{"Load images"}
							</Button>
						</>
					) : alwaysForSender ? (
						<>
							<span>{`Images from ${senderEmail} are loaded automatically.`}</span>
							<Button size="xs" variant="default" loading={savingPref} onClick={blockRemoteImagesAgain}>
								{"Stop loading automatically"}
							</Button>
						</>
					) : (
						<>
							<span>{"Remote images loaded for this message."}</span>
							<Button size="xs" variant="default" onClick={() => setShowRemoteImages(false)}>
								{"Block again"}
							</Button>
						</>
					)}
				</div>
			)}

			<div ref={hostRef} style={{ display: "block", width: "100%" }} />
			{/* A real labelled button; the icon alone went unnoticed. */}
			{hasQuotes && (
				<Button
					type="button"
					variant="default"
					size="xs"
					mt="sm"
					leftSection={<Ellipsis size={14} />}
					onClick={() => setHideQuotes((v) => !v)}
				>
					{hideQuotes ? "Show previous messages" : "Hide previous messages"}
				</Button>
			)}
		</div>
	);
}

// Remote images, discreet presentation (modern interface). Blocked: a notice
// with the button to show them. Already loaded (automatically for this sender,
// or for this message): a single grey line with a link.
function KImagesNotice({
	blocked,
	always,
	sender,
	saving,
	onLoad,
	onStopAuto,
	onHide,
}: {
	blocked: boolean;
	always: boolean;
	sender: string;
	saving: boolean;
	onLoad: () => void;
	onStopAuto: () => void;
	onHide: () => void;
}) {
	const link =
		"rounded-[4px] font-medium text-k-ink-2 underline decoration-k-line-strong underline-offset-2 transition-colors hover:text-k-accent hover:decoration-k-accent disabled:opacity-50";
	if (blocked) {
		return (
			<div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-k border border-k-line bg-k-surface-2 px-3 py-2 text-[12.5px] text-k-ink-2">
				<ImageOff size={15} className="shrink-0 text-k-ink-3" aria-hidden />
				<span className="min-w-0 flex-1">Images hidden to protect your privacy.</span>
				<button
					type="button"
					onClick={onLoad}
					disabled={saving}
					title={`Also loads them automatically in future messages from ${sender}`}
					className="rounded-k-sm bg-k-accent px-2.5 py-1 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
				>
					Load images
				</button>
			</div>
		);
	}
	return (
		<div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-k-ink-3">
			<ImageIcon size={13} className="shrink-0" aria-hidden />
			{always ? (
				<>
					<span>Images always loaded for {sender}</span>
					<span aria-hidden>·</span>
					<button type="button" onClick={onStopAuto} disabled={saving} className={link}>
						Stop loading automatically
					</button>
				</>
			) : (
				<>
					<span>Images loaded for this message</span>
					<span aria-hidden>·</span>
					<button type="button" onClick={onHide} className={link}>
						Hide
					</button>
				</>
			)}
		</div>
	);
}
