"use client";

// Error above the mail area (dashboard and workspace layouts): go back to the root
// instead of Next's Reload. See components/common/recover-error.tsx.
import { RecoverError } from "@/components/common/recover-error";

export default function AppError({ error }: { error: Error & { digest?: string } }) {
	return <RecoverError error={error} />;
}
