import { defineNitroPlugin } from "nitropack/runtime";
import { backfillMailSubscriptions } from "../../lib/maintenance/backfill-subscriptions";

// ss2i : operations de maintenance ponctuelles, lancees au demarrage du worker derriere une
// variable d'environnement (retirer la variable apres le passage ; elles sont de toute facon
// idempotentes).
//   KURRIER_BACKFILL_SUBSCRIPTIONS=1 : reconstruit mail_subscriptions depuis les messages.
export default defineNitroPlugin(() => {
	if (process.env.KURRIER_BACKFILL_SUBSCRIPTIONS === "1") {
		backfillMailSubscriptions().catch((err) =>
			console.error("[backfill-subscriptions] echec:", err?.message ?? err),
		);
	}
});
