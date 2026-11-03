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
import { useK } from "@/components/k/ui-context";

type UpdateSignatureAction = (_prev: FormState, formData: FormData) => Promise<FormState>;

// Signature HTML de l'identite. Elle est ajoutee par le worker a l'envoi, apres le
// corps et avant la citation du message d'origine ; l'editeur en affiche un
// apercu et permet de la retirer pour un message donne.
export default function SettingsSignature({
	updateSignature,
	identity,
}: {
	updateSignature: UpdateSignatureAction;
	identity: IdentityEntity;
}) {
	const pathname = usePathname();
	const k = useK();
	const initial = String((identity.metaData as any)?.signatureHtml ?? "");
	const [html, setHtml] = useState(initial);
	const [formState, formAction, isPending] = useActionState<FormState, FormData>(
		updateSignature,
		{},
	);

	useEffect(() => {
		if (formState.error) toast.error(k("Error", "Erreur"), { description: formState.error });
		else if (formState.success) toast.success(k("Signature saved", "Signature enregistrée"));
	}, [formState]);

	// ss2i : apercu calcule apres le montage. Calcule pendant le rendu, il etait
	// vide cote serveur et rempli cote navigateur : React ne corrige pas un
	// innerHTML different a l'hydratation, l'apercu restait vide jusqu'a la
	// premiere modification.
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const preview = useMemo(() => (mounted ? DOMPurify.sanitize(html) : ""), [html, mounted]);

	return (
		<SectionCard
			title={k("Signature", "Signature")}
			description={k(
				"HTML appended to every message sent from this identity. Leave empty for no signature.",
				"HTML ajouté à chaque message envoyé depuis cette identité. Laissez vide pour ne pas avoir de signature.",
			)}
		>
			<Form action={formAction} className="space-y-4">
				<input type="hidden" name="id" value={identity.id} />
				<input type="hidden" name="pathname" value={pathname} />
				<Textarea
					name="signatureHtml"
					label={k("Signature (HTML)", "Signature (HTML)")}
					autosize
					minRows={6}
					maxRows={20}
					value={html}
					onChange={(e) => setHtml(e.currentTarget.value)}
					styles={{ input: { fontFamily: "var(--font-mono)", fontSize: 12 } }}
				/>
				<div>
					<div className="text-sm font-medium mb-2">{k("Preview", "Aperçu")}</div>
					<div
						className="rounded-md border border-neutral-200 dark:border-neutral-800 p-3 min-h-16 bg-white text-neutral-900"
						dangerouslySetInnerHTML={{ __html: preview }}
					/>
				</div>
				<div className="flex items-center justify-end">
					<Button type="submit" loading={isPending}>
						{k("Save signature", "Enregistrer la signature")}
					</Button>
				</div>
			</Form>
		</SectionCard>
	);
}
