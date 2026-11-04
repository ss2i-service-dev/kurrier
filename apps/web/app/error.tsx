"use client";

// ss2i : erreur au-dessus de la messagerie (layouts du dashboard, du workspace) : retour a
// la racine au lieu du Reload de Next. Voir components/common/recover-error.tsx.
import { RecoverError } from "@/components/common/recover-error";

export default function AppError({ error }: { error: Error & { digest?: string } }) {
	return <RecoverError error={error} />;
}
