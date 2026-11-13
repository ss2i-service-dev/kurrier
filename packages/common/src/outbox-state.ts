// ss2i : Boite d'envoi (OI 10519). Une ligne draft_messages par envoi (ledger) ; l'etat affiche,
// la visibilite dans la Boite d'envoi, le compteur et les actions possibles sont calcules ici, et
// seulement ici. Pur (ni base, ni Redis) : importable cote client (cf. apps/web/test/outbox.ts).
//
// status garde son sens (sent = accepte par le serveur SMTP) ; delivery_state porte la suite
// (file distante, lot 2) : none, queued, canceling, delivered, rejected, unknown.

export type SendState =
	| "pending" // en attente : delai d'annulation ou heure programmee
	| "sending" // en cours d'envoi (claim du worker)
	| "failed" // refus certain du serveur
	| "interrupted" // issue inconnue : peut-etre parti
	| "canceled"
	| "delivered" // remis (accepte par le SMTP, ou preuve de remise au lot 2)
	| "queued" // en file distante (lot 2)
	| "canceling" // annulation en file demandee (lot 2)
	| "rejected" // refuse apres la file (lot 2)
	| "unknown"; // ni file ni journal (lot 2)

export type LedgerStateRow = {
	status: string;
	deliveryState?: string | null;
	acceptanceUnknown?: boolean | null;
	acceptedAt?: Date | string | null;
	dismissedAt?: Date | string | null;
};

export function sendStateOf(row: LedgerStateRow): SendState | null {
	switch (row.status) {
		case "scheduled":
			return "pending";
		case "sending":
			return "sending";
		case "failed":
			return row.acceptanceUnknown ? "interrupted" : "failed";
		case "canceled":
			return "canceled";
		case "sent":
			switch (row.deliveryState) {
				case "queued":
					return "queued";
				case "canceling":
					return "canceling";
				case "rejected":
					return "rejected";
				case "unknown":
					return "unknown";
				default:
					return "delivered";
			}
		default:
			return null;
	}
}

// En cours : toujours visibles. Echecs : visibles tant que l'utilisateur ne les a pas ecartes
// (dismissed_at). Remis et annules : jamais.
const ALWAYS_VISIBLE: SendState[] = ["pending", "sending", "queued", "canceling", "unknown"];
const VISIBLE_UNTIL_DISMISSED: SendState[] = ["failed", "interrupted", "rejected"];
// Etats « normaux » du compteur ; tout autre etat visible le passe en alerte (rouge).
const CALM: SendState[] = ["pending", "sending", "queued"];

export function isOutboxVisible(row: LedgerStateRow): boolean {
	const state = sendStateOf(row);
	if (!state) return false;
	if (ALWAYS_VISIBLE.includes(state)) return true;
	return VISIBLE_UNTIL_DISMISSED.includes(state) && !row.dismissedAt;
}

export type OutboxCount = { total: number; alert: number };

export function outboxCountOf(rows: LedgerStateRow[]): OutboxCount {
	let total = 0;
	let alert = 0;
	for (const row of rows) {
		if (!isOutboxVisible(row)) continue;
		total++;
		if (!CALM.includes(sendStateOf(row)!)) alert++;
	}
	return { total, alert };
}

export type OutboxActions = {
	cancel: boolean; // Annuler l'envoi (CAS scheduled -> canceled)
	sendNow: boolean; // Envoyer maintenant
	retry: boolean; // Reessayer (CAS failed -> scheduled), jamais apres acceptation
	confirmRetry: boolean; // « ce mail est peut-etre deja parti » avant de reessayer
	dismiss: boolean; // Remettre en brouillon (ecarte de la Boite d'envoi)
};

export function outboxActionsOf(row: LedgerStateRow): OutboxActions {
	const state = sendStateOf(row);
	const pending = state === "pending";
	const failed = state === "failed" || state === "interrupted";
	return {
		cancel: pending,
		sendNow: pending,
		retry: failed && !row.acceptedAt,
		confirmRetry: state === "interrupted" && !row.acceptedAt,
		dismiss: failed || state === "rejected",
	};
}
