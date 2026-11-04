"use client";

// ss2i : erreur dans le layout racine lui-meme. global-error remplace tout le document,
// d'ou html et body. Meme retour a la racine que app/error.tsx.
import { RecoverError } from "@/components/common/recover-error";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
	return (
		<html lang="fr">
			<body style={{ margin: 0, background: "#0a0a0a", color: "#eee" }}>
				<RecoverError error={error} />
			</body>
		</html>
	);
}
