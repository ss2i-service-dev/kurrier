import { redirect } from "next/navigation";

// ss2i : .../dashboard/mail sans identite affichait « Select a mailbox » : on rejoint la
// boite de reception de l'identite par defaut, comme la racine.
export default function Page() {
	redirect("/api/auth/resume");
}
