"use client";

import React, { useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { X } from "lucide-react";
import { detachThreadClient } from "@/lib/actions/thread-clients";
import { useK } from "@/components/k/ui-context";

// ss2i clients : detache le fil du client (memorise : le rattrapage ne le remet pas).
export default function DetachClientButton({
	threadId,
	identityPublicId,
	companyId,
	name,
}: {
	threadId: string;
	identityPublicId: string;
	companyId: number;
	name: string;
}) {
	const k = useK();
	const [pending, startTransition] = useTransition();
	const router = useRouter();
	const pathname = usePathname();
	return (
		<button
			type="button"
			disabled={pending}
			title={k(`Not ${name}: detach this thread from the client`, `Pas ${name} : détacher ce fil du client`)}
			aria-label={k(`Detach this thread from ${name}`, `Détacher ce fil de ${name}`)}
			className="ml-0.5 rounded-full opacity-50 hover:opacity-100 disabled:opacity-30"
			onClick={() => {
				if (!window.confirm(k(`Detach this thread from ${name}?`, `Détacher ce fil de ${name} ?`))) return;
				startTransition(async () => {
					await detachThreadClient(threadId, identityPublicId, companyId, pathname);
					router.refresh();
				});
			}}
		>
			<X className="h-3.5 w-3.5" />
		</button>
	);
}
