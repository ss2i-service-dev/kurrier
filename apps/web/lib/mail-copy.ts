"use client";
// Copy of a message or a whole thread to the clipboard, as plain text readable by an AI
// agent: headers (From, To, Cc, Date, Subject, attachments) then body converted from the
// HTML (headings, lists, links and tables kept).
// Thread: messages from oldest to newest, the quoted history of each message is cut (it
// repeats the previous messages, already copied), except for the first one, whose quote
// may carry an exchange older than the thread.
import { stripQuotedHtml, stripQuotedText } from "@common/compose";
import { toast } from "sonner";
import { joinSurrogateEntities } from "@common/html-entities";
import { fetchMessagesForCopy, type CopyAddress, type CopyMessage } from "@/lib/actions/mail-copy";

const BLOCK = new Set([
	"address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "fieldset", "figcaption",
	"figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main",
	"nav", "ol", "p", "pre", "section", "table", "tbody", "thead", "tfoot", "tr", "ul",
]);

export function htmlToText(html: string): string {
	const doc = new DOMParser().parseFromString(joinSurrogateEntities(html), "text/html");
	doc.querySelectorAll("script, style, head, title, meta, noscript, template").forEach((n) => n.remove());
	let out = "";
	const nl = (n = 1) => {
		const trail = out.match(/\n*$/)?.[0].length ?? 0;
		if (out.length && trail < n) out += "\n".repeat(n - trail);
	};
	const walk = (node: Node, pre = false) => {
		if (node.nodeType === Node.TEXT_NODE) {
			let t = pre ? (node.textContent ?? "") : (node.textContent ?? "").replace(/\s+/g, " ");
			if (!pre && (out === "" || /\s$/.test(out))) t = t.replace(/^ /, "");
			out += t;
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const el = node as HTMLElement;
		const tag = el.tagName.toLowerCase();
		if (el.style?.display === "none") return;
		if (tag === "br") {
			out = out.replace(/ +$/, "") + "\n";
			return;
		}
		if (tag === "img") {
			const alt = el.getAttribute("alt")?.trim();
			if (alt) out += `[${alt}]`;
			return;
		}
		const block = BLOCK.has(tag);
		if (block) nl(/^(p|h\d|table|ul|ol|blockquote|pre|hr)$/.test(tag) ? 2 : 1);
		if (/^h\d$/.test(tag)) out += "#".repeat(Number(tag[1])) + " ";
		if (tag === "li") {
			const ol = el.parentElement?.tagName.toLowerCase() === "ol";
			const idx = ol ? Array.from(el.parentElement!.children).indexOf(el) + 1 : 0;
			out += ol ? `${idx}. ` : "- ";
		}
		if (tag === "hr") out += "---";
		const start = out.length;
		el.childNodes.forEach((c) => walk(c, pre || tag === "pre"));
		if (tag === "td" || tag === "th") {
			out = out.replace(/\s+$/, "") + " | ";
		}
		if (tag === "tr") out = out.replace(/ \| $/, "");
		if (tag === "a") {
			const href = el.getAttribute("href") ?? "";
			const label = out.slice(start).trim();
			if (/^https?:|^mailto:/i.test(href) && label && !href.replace(/^mailto:/i, "").includes(label) && !label.includes(href))
				out += ` (${href.replace(/^mailto:/i, "")})`;
		}
		if (tag === "blockquote") {
			const quoted = out.slice(start).trim().split("\n").map((l) => `> ${l}`).join("\n");
			out = out.slice(0, start) + quoted;
		}
		if (block) nl(/^(p|h\d|table|ul|ol|blockquote|pre|hr)$/.test(tag) ? 2 : 1);
	};
	walk(doc.body ?? doc.documentElement);
	return out
		.replace(/ /g, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

const fmtAddr = (a: CopyAddress) =>
	a.name && a.address && a.name !== a.address ? `${a.name} <${a.address}>` : (a.address ?? a.name ?? "");
const fmtList = (l: CopyAddress[]) => l.map(fmtAddr).filter(Boolean).join(", ");
const fmtDate = (iso: string | null) =>
	iso
		? new Date(iso).toLocaleString(undefined, {
				weekday: "long",
				day: "numeric",
				month: "long",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			})
		: "";

function bodyOf(m: CopyMessage, stripQuotes: boolean): string {
	if (m.html && m.html.trim()) {
		const html = stripQuotes ? stripQuotedHtml(m.html).html : m.html;
		const t = htmlToText(html);
		if (t) return t;
	}
	const text = (m.text ?? "").trim();
	return stripQuotes ? stripQuotedText(text) : text;
}

function messageBlock(m: CopyMessage, stripQuotes: boolean, withSubject: boolean): string {
	const head = [
		`From: ${fmtList(m.from)}`,
		m.to.length ? `To: ${fmtList(m.to)}` : null,
		m.cc.length ? `Cc: ${fmtList(m.cc)}` : null,
		m.date ? `Date: ${fmtDate(m.date)}` : null,
		withSubject ? `Subject: ${m.subject || "(no subject)"}` : null,
		m.attachments.length ? `Attachments: ${m.attachments.join(", ")}` : null,
	].filter(Boolean);
	return `${head.join("\n")}\n\n${bodyOf(m, stripQuotes)}`;
}

export function formatMessage(m: CopyMessage): string {
	return messageBlock(m, false, true);
}

export function formatThread(list: CopyMessage[]): string {
	if (list.length === 1) return formatMessage(list[0]);
	const subject = list[list.length - 1]?.subject || list[0]?.subject || "(no subject)";
	const parts = list.map((m, i) => {
		// The subject is only repeated when it changes within the thread.
		const changed = (m.subject ?? "") !== (list[i - 1]?.subject ?? m.subject ?? "");
		return `===== Message ${i + 1}/${list.length} =====\n${messageBlock(m, i > 0, changed)}`;
	});
	return [
		`Subject: ${subject}`,
		`Thread of ${list.length} messages, oldest to newest (quoted history removed from the 2nd message).`,
		"",
		parts.join("\n\n"),
	].join("\n");
}

// Writes the text produced by `make` to the clipboard. ClipboardItem receives a
// promise: the write stays tied to the click even if the server read takes time
// (Safari refuses otherwise); falls back to writeText.
async function copyAsync(make: () => Promise<string>): Promise<string> {
	let text: Promise<string> | null = null;
	const run = () => (text ??= make());
	if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
		try {
			await navigator.clipboard.write([
				new ClipboardItem({ "text/plain": run().then((t) => new Blob([t], { type: "text/plain" })) }),
			]);
			return run();
		} catch {
			// Write refused: retry as plain text.
		}
	}
	const t = await run();
	await navigator.clipboard.writeText(t);
	return t;
}

export async function copyMailToClipboard(opts: { threadId?: string; messageId?: string }) {
	const what = opts.messageId ? "Message" : "Thread";
	try {
		let count = 0;
		const text = await copyAsync(async () => {
			const list = await fetchMessagesForCopy(opts);
			count = list.length;
			if (!list.length) throw new Error("empty");
			return opts.messageId ? formatMessage(list[0]) : formatThread(list);
		});
		toast.success(
			opts.messageId
				? "Message copied to the clipboard"
				: `Thread copied to the clipboard (${count} message${count > 1 ? "s" : ""})`,
			{ description: `${text.length.toLocaleString()} characters` },
		);
	} catch (e) {
		console.error("[mail-copy]", e);
		toast.error(`${what} not copied`, { description: "The clipboard refused the write or the content could not be found." });
	}
}
