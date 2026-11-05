import { isModernUi } from "@/lib/actions/interface-pref";
import { Users } from "lucide-react";
import { KEmptyState } from "@/components/k/section";

import React from "react";

function ClassicPage() {
	return (
		<div className={"flex items-center justify-center my-24 text-sm"}>
			Please select a contact to view details.
		</div>
	);
}

// Modern interface: empty detail pane to the right of the list.
export default async function Page() {
	if (!(await isModernUi())) return <ClassicPage />;
	return (
		<KEmptyState
			icon={<Users size={22} strokeWidth={1.6} />}
			title="No contact selected"
			text="Choose a contact from the list to see its details, or create a new one."
		/>
	);
}
