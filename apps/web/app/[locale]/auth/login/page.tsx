import { LoginForm } from "@/components/auth/login-form";
import Link from "next/link";
import KurrierLogo from "@/components/common/kurrier-logo";
import * as React from "react";
import {getDictionary, Locale} from "@/lib/dictionaries";
import { ceriseBaseUrl } from "@common/cerise-auth";
import { getServerEnv } from "@schema";
import { readPendingCeriseLink } from "@/lib/cerise-account";

// ss2i (OI 10297) : retours de la connexion par Cerise (?message=cerise_*).
const CERISE_MESSAGES: Record<string, string> = {
	cerise_state: "La connexion par Cerise a expiré ou a été lancée depuis un autre onglet. Recommence.",
	cerise_rejected: "Cerise n'a pas validé la connexion. Recommence.",
	cerise_unreachable: "Cerise ne répond pas pour l'instant. Réessaie, ou connecte-toi avec ton mot de passe.",
	cerise_domain: "La connexion par Cerise est réservée aux adresses SS2i Services.",
	cerise_ambiguous: "Ce compte Cerise est déjà lié à un autre compte courrier. Connecte-toi avec ton mot de passe.",
};

export default async function LoginPage({ params, searchParams }: {
	params: Promise<{ locale: Locale }>;
	searchParams: Promise<{ message?: string }>;
}) {

	const sParams = await searchParams;
	const nParams = await params;
	const dict = await getDictionary(nParams.locale);
	const showSignupDisabledMessage = sParams.message === "signup_disabled";
	const googleEnabled = process.env.OIDC_GOOGLE_CLIENT_ID && process.env.OIDC_GOOGLE_CLIENT_SECRET;
	const ceriseEnabled = !!ceriseBaseUrl(getServerEnv().CERISE_URL);
	const ceriseMessage = sParams.message ? CERISE_MESSAGES[sParams.message] : undefined;
	const pendingLink = ceriseEnabled ? await readPendingCeriseLink() : null;


	return (
		<div className="bg-muted flex min-h-svh flex-col items-center justify-center gap-6 p-6 md:p-10">
			<div className="flex w-full max-w-sm flex-col gap-6">
				<Link
					href="/"
					className="flex items-center gap-2 self-center font-medium"
				>
					<KurrierLogo size={56} />
					<span className="truncate font-medium text-4xl">Kurrier</span>
				</Link>
				{showSignupDisabledMessage && (
					<div className="rounded-md bg-yellow-50 border border-yellow-200 p-3">
						<p className="text-sm text-yellow-800">
							User registration is currently disabled. Please contact your
							administrator for access.
						</p>
					</div>
				)}
				{ceriseMessage && (
					<div className="rounded-md bg-yellow-50 border border-yellow-200 p-3">
						<p className="text-sm text-yellow-800">{ceriseMessage}</p>
					</div>
				)}
				{pendingLink && (
					<div className="rounded-md bg-blue-50 border border-blue-200 p-3" data-testid="cerise-link-pending">
						<p className="text-sm text-blue-900">
							Cerise t&apos;a reconnu comme <strong>{pendingLink.email}</strong>. Cette adresse est une identité
							de ton compte courrier : connecte-toi une fois avec ton adresse et ton mot de passe courrier,
							les deux connexions seront liées. Ensuite, le bouton Cerise suffira.
						</p>
					</div>
				)}
				<LoginForm dict={dict} oidc={{
					googleEnabled: !!googleEnabled,
					ceriseEnabled,
				}} />
			</div>
		</div>
	);
}
