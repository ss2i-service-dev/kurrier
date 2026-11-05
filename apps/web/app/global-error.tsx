"use client";

// Error in the root layout itself. global-error replaces the whole document, hence
// html and body. Same return to the root as app/error.tsx.
import { RecoverError } from "@/components/common/recover-error";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
	return (
		<html lang="en">
			<body style={{ margin: 0, background: "#0a0a0a", color: "#eee" }}>
				<RecoverError error={error} />
			</body>
		</html>
	);
}
