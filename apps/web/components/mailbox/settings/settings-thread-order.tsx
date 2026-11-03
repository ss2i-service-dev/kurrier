"use client";
import { useState, useTransition } from "react";
import { SegmentedControl, Text } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setThreadOrder, type ThreadOrder } from "@/lib/actions/thread-order";
import { useK } from "@/components/k/ui-context";

// ss2i : ordre des messages dans un fil ouvert (option par utilisateur,
// memorisee cote serveur). Rendu a l'interieur de la carte « Reading ».
function SettingsThreadOrder({ order: initial }: { order: ThreadOrder }) {
	const [order, setOrder] = useState<ThreadOrder>(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();
	// ss2i : francais dans l'interface Outlook, anglais d'origine dans Gmail.
	const t = useK();

	const onChange = (value: string) => {
		const next: ThreadOrder =
			value === "newest_first" ? "newest_first" : "oldest_first";
		const previous = order;
		setOrder(next);
		startTransition(async () => {
			const r = await setThreadOrder(next);
			if (r?.success === false) {
				setOrder(previous);
				toast.error(r.error ?? t("Could not save the preference", "Impossible d'enregistrer la préférence"));
				return;
			}
			toast.success(
				next === "newest_first"
					? t("Conversations show the newest message at the top.", "Le message le plus récent s'affiche en haut des conversations.")
					: t("Conversations show the newest message at the bottom.", "Le message le plus récent s'affiche en bas des conversations."),
			);
			router.refresh();
		});
	};

	return (
		<div className="mt-4">
			<Text size="sm" fw={500}>
				{t("Conversation order", "Ordre des messages")}
			</Text>
			<Text size="xs" c="dimmed" mb={6}>
				{t(
					"Order of the messages in an open conversation. The Reply buttons always stay under the newest message.",
					"Ordre des messages dans une conversation ouverte. La réponse se rédige toujours sous le message le plus récent.",
				)}
			</Text>
			<SegmentedControl
				value={order}
				disabled={pending}
				onChange={onChange}
				data={[
					{ value: "newest_first", label: t("Newest at the top", "Le plus récent en haut") },
					{ value: "oldest_first", label: t("Newest at the bottom", "Le plus récent en bas") },
				]}
			/>
		</div>
	);
}

export default SettingsThreadOrder;
