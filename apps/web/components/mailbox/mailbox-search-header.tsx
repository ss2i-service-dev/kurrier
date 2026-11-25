import React from 'react';
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import MailboxSearch from "@/components/mailbox/default/mailbox-search";
import IdentitySettingsLink from "@/components/mailbox/settings/identity-settings";
import MailHeaderHeight from "@/components/mailbox/mail-header-height";
import {getWorkspacePublicId, rlsClient} from "@/lib/actions/clients";
import { identities, mailboxes } from "@db";
import { and, eq } from "drizzle-orm";
import { CLEANUP_ALLOWED_KINDS } from "@common";
import { isSignedIn } from "@/lib/actions/auth";

async function MailboxSearchHeader({params}: {params: Promise<Record<string, string>>}) {
    const { identityPublicId, mailboxSlug } = await params;
    const workspacePublicId = await getWorkspacePublicId()

    const rls = await rlsClient();
    const [identity] = await rls((tx) =>
        tx
            .select({
                id: identities.id,
                value: identities.value,
                ownerId: identities.ownerId,
            })
            .from(identities)
            .where(eq(identities.publicId, identityPublicId))
    );

    const identityLabel = identity?.value;

    // ss2i : « Nettoyage auto... » (docs/plans/nettoyage-auto-recherche.md, MT11) : une regle est a son auteur,
    // proprietaire de l'identite ; l'identite est deja relue ci-dessus, seul le dossier courant (meme repli sur
    // l'Inbox que la recherche) s'ajoute, une ligne.
    const user = await isSignedIn();
    let cleanup: { mailboxName: string; mailboxCleanable: boolean } | undefined;
    if (identity && user?.id && identity.ownerId === user.id) {
        const slug = !mailboxSlug || mailboxSlug === "undefined" || mailboxSlug === "clients" ? "inbox" : mailboxSlug;
        const [mailbox] = await rls((tx) =>
            tx
                .select({ name: mailboxes.name, kind: mailboxes.kind })
                .from(mailboxes)
                .where(and(eq(mailboxes.identityId, identity.id), eq(mailboxes.slug, slug)))
                .limit(1)
        );
        cleanup = {
            mailboxName: mailbox?.name ?? slug,
            mailboxCleanable: !!mailbox && (CLEANUP_ALLOWED_KINDS as readonly string[]).includes(mailbox.kind),
        };
    }

    // ss2i : une seule ligne sur mobile (marges reduites), hauteur publiee pour les barres collees dessous.
    return <header data-ss2i-mail-header="" className={"bg-background sticky top-0 flex shrink-0 items-center gap-2 border-b px-3 py-2 md:p-4 z-50"}>
        <MailHeaderHeight />
        <SidebarTrigger className="-ml-1" />
        <Separator
            orientation="vertical"
            className="mr-1 md:mr-2 data-[orientation=vertical]:h-4"
        />
        <MailboxSearch
            publicId={identityPublicId}
            mailboxSlug={mailboxSlug}
            workspacePublicId={workspacePublicId}
            cleanup={cleanup}
        />
        <IdentitySettingsLink identityLabel={identityLabel} workspacePublicId={workspacePublicId} />
    </header>
}

export default MailboxSearchHeader;
