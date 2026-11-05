import { defineNitroPlugin } from "nitropack/runtime";
import { backfillMailSubscriptions } from "../../lib/maintenance/backfill-subscriptions";

// One-off maintenance operations, run at worker startup behind an environment variable
// (unset it afterwards; they are idempotent anyway).
//   KURRIER_BACKFILL_SUBSCRIPTIONS=1: rebuilds mail_subscriptions from existing messages.
export default defineNitroPlugin(() => {
	if (process.env.KURRIER_BACKFILL_SUBSCRIPTIONS === "1") {
		backfillMailSubscriptions().catch((err) =>
			console.error("[backfill-subscriptions] failed:", err?.message ?? err),
		);
	}
});
