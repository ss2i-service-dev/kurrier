"use client";
import { useState, useTransition } from "react";
import { SegmentedControl, Text } from "@mantine/core";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setThreadOrder, type ThreadOrder } from "@/lib/actions/thread-order";


// Order of the messages in an open thread (per-user option, stored server-side).
// Rendered inside the "Reading" card.
function SettingsThreadOrder({ order: initial }: { order: ThreadOrder }) {
	const [order, setOrder] = useState<ThreadOrder>(initial);
	const [pending, startTransition] = useTransition();
	const router = useRouter();

	const onChange = (value: string) => {
		const next: ThreadOrder =
			value === "newest_first" ? "newest_first" : "oldest_first";
		const previous = order;
		setOrder(next);
		startTransition(async () => {
			const r = await setThreadOrder(next);
			if (r?.success === false) {
				setOrder(previous);
				toast.error(r.error ?? "Could not save the preference");
				return;
			}
			toast.success(
				next === "newest_first"
					? "Conversations show the newest message at the top."
					: "Conversations show the newest message at the bottom.",
			);
			router.refresh();
		});
	};

	return (
		<div className="mt-4">
			<Text size="sm" fw={500}>
				{"Conversation order"}
			</Text>
			<Text size="xs" c="dimmed" mb={6}>
				{"Order of the messages in an open conversation. The Reply buttons always stay under the newest message."}
			</Text>
			<SegmentedControl
				value={order}
				disabled={pending}
				onChange={onChange}
				data={[
					{ value: "newest_first", label: "Newest at the top" },
					{ value: "oldest_first", label: "Newest at the bottom" },
				]}
			/>
		</div>
	);
}

export default SettingsThreadOrder;
