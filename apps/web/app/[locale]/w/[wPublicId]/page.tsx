import { redirect } from "next/navigation";

// ss2i : niveau d'URL sans page (404 auparavant) : on rejoint la boite de reception par la
// route de reprise de session, comme la racine. Remonter dans l'URL ne bloque jamais.
export default function Page() {
	redirect("/api/auth/resume");
}
