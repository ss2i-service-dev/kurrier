"use client";
import React, { useActionState, useEffect, useMemo, useState } from "react";
import Form from "next/form";
import DOMPurify from "dompurify";
import { Button, Textarea } from "@mantine/core";
import { usePathname } from "next/navigation";
import { toast } from "sonner";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import type { IdentityEntity } from "@db";
import type { FormState } from "@schema";


type UpdateSignatureAction = (_prev: FormState, formData: FormData) => Promise<FormState>;

// HTML signature of the identity. The worker appends it when sending, after the
// body and before the quoted original message; the editor shows a preview and
// lets the user remove it for a given message.
export default function SettingsSignature({
	updateSignature,
	identity,
}: {
	updateSignature: UpdateSignatureAction;
	identity: IdentityEntity;
}) {
	const pathname = usePathname();
	const initial = String((identity.metaData as any)?.signatureHtml ?? "");
	const [html, setHtml] = useState(initial);
	const [formState, formAction, isPending] = useActionState<FormState, FormData>(
		updateSignature,
		{},
	);

	useEffect(() => {
		if (formState.error) toast.error("Error", { description: formState.error });
		else if (formState.success) toast.success("Signature saved");
	}, [formState]);

	// Preview computed after mount. Computed during render it would be empty on
	// the server and filled in the browser: React does not patch a differing
	// innerHTML at hydration, so the preview would stay empty until the first edit.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const preview = useMemo(() => (mounted ? DOMPurify.sanitize(html) : ""), [html, mounted]);

	return (
		<SectionCard
			title={"Signature"}
			description={"HTML appended to every message sent from this identity. Leave empty for no signature."}
		>
			<Form action={formAction} className="space-y-4">
				<input type="hidden" name="id" value={identity.id} />
				<input type="hidden" name="pathname" value={pathname} />
				<Textarea
					name="signatureHtml"
					label={"Signature (HTML)"}
					autosize
					minRows={6}
					maxRows={20}
					value={html}
					onChange={(e) => setHtml(e.currentTarget.value)}
					styles={{ input: { fontFamily: "var(--font-mono)", fontSize: 12 } }}
				/>
				<div>
					<div className="text-sm font-medium mb-2">{"Preview"}</div>
					<div
						className="rounded-md border border-neutral-200 dark:border-neutral-800 p-3 min-h-16 bg-white text-neutral-900"
						dangerouslySetInnerHTML={{ __html: preview }}
					/>
				</div>
				<div className="flex items-center justify-end">
					<Button type="submit" loading={isPending}>
						{"Save signature"}
					</Button>
				</div>
			</Form>
		</SectionCard>
	);
}
