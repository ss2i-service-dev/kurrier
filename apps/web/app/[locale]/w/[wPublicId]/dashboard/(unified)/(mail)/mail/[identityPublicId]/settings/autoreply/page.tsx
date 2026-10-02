import React from "react";
import SettingsAutoReply from "@/components/mailbox/settings/settings-autoreply";
import { fetchVacation, saveVacation, type VacationResponse } from "@/lib/actions/vacation";

async function Page({ params }: { params: Promise<Record<string, string>> }) {
	const { identityPublicId } = await params;
	let vacation: VacationResponse | null = null;
	let error: string | null = null;
	try {
		vacation = await fetchVacation(identityPublicId);
	} catch (e: any) {
		error = e?.message ?? String(e);
	}
	return (
		<SettingsAutoReply
			identityPublicId={identityPublicId}
			vacation={vacation}
			error={error}
			save={saveVacation}
		/>
	);
}

export default Page;
