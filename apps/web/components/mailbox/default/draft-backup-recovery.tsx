"use client";
// Puts back into Drafts the drafts the server never received (local copy kept by
// lib/draft-backup.ts). Runs when the mailbox loads, then every 15 s, so a reload, a tab
// crash or a redeploy does not lose anything.
import { useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveDraft } from "@/lib/actions/drafts";
import { aliveAt, listBackups, removeBackup, type DraftBackup } from "@/lib/draft-backup";

// A live editor beats every second; past this delay its draft is orphaned.
const ORPHAN_MS = 10_000;
// A sent message is not recovered; its copy is kept for a day, then deleted.
const SENT_KEEP_MS = 24 * 3600_000;
const SAVED_KEEP_MS = 60_000;
const RETRY_MS = 15_000;

export default function DraftBackupRecovery() {
	const router = useRouter();
	const params = useParams() as { wPublicId?: string };
	const busy = useRef(false);
	const warned = useRef(new Set<string>());

	useEffect(() => {
		const recover = async (b: DraftBackup) => {
			const p = b.payload as Record<string, any>;
			const base = { ...p, identityPublicId: b.identityPublicId } as any;
			let res = await saveDraft({ ...base, draftMessageId: b.draftMessageId });
			// Original draft deleted in the meantime: create a new one.
			if (!res?.draftMessageId && b.draftMessageId) {
				res = await saveDraft({ ...base, draftMessageId: null });
			}
			if (!res?.draftMessageId) throw new Error(res?.error ?? "Draft could not be saved.");
			removeBackup(b.id);
			const subject = String(p.subject ?? "").trim() || "(no subject)";
			toast.success("Unsaved draft recovered", {
				position: "bottom-left",
				duration: 20_000,
				description: `"${subject}" is back in Drafts with everything you typed.`,
				action: params.wPublicId
					? {
							label: "Open Drafts",
							onClick: () =>
								router.push(
									`/w/${params.wPublicId}/dashboard/mail/${b.identityPublicId}/drafts`,
								),
						}
					: undefined,
			});
		};

		const run = async () => {
			if (busy.current) return;
			busy.current = true;
			let recovered = false;
			try {
				const now = Date.now();
				for (const b of listBackups()) {
					if (now - Math.max(aliveAt(b.id), b.updatedAt) < ORPHAN_MS) continue;
					if (b.sentAt) {
						if (now - b.sentAt > SENT_KEEP_MS) removeBackup(b.id);
						continue;
					}
					if (b.savedKey === b.key) {
						if (now - b.updatedAt > SAVED_KEEP_MS) removeBackup(b.id);
						continue;
					}
					try {
						await recover(b);
						recovered = true;
					} catch (e: any) {
						// The copy stays in the browser; retried on the next run.
						if (!warned.current.has(b.id)) {
							warned.current.add(b.id);
							toast.error("A draft is waiting to be saved", {
								position: "bottom-left",
								duration: Infinity,
								id: `kurrier-draft-recovery-${b.id}`,
								description: `"${String(b.payload.subject ?? "").trim() || "(no subject)"}" is kept in this browser and will be retried. ${String(e?.message ?? e)}`,
							});
						}
					}
				}
			} finally {
				busy.current = false;
			}
			if (recovered) router.refresh();
		};

		void run();
		const t = setInterval(run, RETRY_MS);
		return () => clearInterval(t);
	}, [router, params.wPublicId]);

	return null;
}
