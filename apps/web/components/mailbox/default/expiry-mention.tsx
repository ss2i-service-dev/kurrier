// Classic interface: orange "Disappears on DD Mon YYYY" mention of a thread archived for a chosen
// duration (same text as thread-row.tsx of the modern interface; standard Tailwind colors, the
// --k-* tokens do not exist in the classic interface). Nothing without an expiry.
import React from "react";
import { formatExpiry } from "@common/thread-expiry";

export default function ExpiryMention({ expiresAt }: { expiresAt: Date | string | null | undefined }) {
	if (!expiresAt) return null;
	const at = new Date(expiresAt);
	return (
		<span
			className="whitespace-nowrap text-xs font-normal tabular-nums text-orange-600 dark:text-orange-400"
			title={`This thread will go to Trash on ${formatExpiry(at)}`}
		>
			Disappears on {formatExpiry(at)}
		</span>
	);
}
