import { redirect } from "next/navigation";

// .../dashboard/mail without an identity used to show "Select a mailbox": go to the
// inbox of the default identity instead, like the root.
export default function Page() {
	redirect("/api/auth/resume");
}
