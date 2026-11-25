import React from "react";
import SectionCard from "@/components/mailbox/settings/settings-section-card";
import CleanupRulesList from "@/components/mailbox/settings/cleanup-rules-list";
import { listCleanupRules } from "@/lib/actions/cleanup-rules";
import { assertIdentityAccess, assertSignedIn } from "@/lib/authz";

// ss2i : regles de nettoyage automatique de l'identite (docs/plans/nettoyage-auto-recherche.md, MT9). Une
// regle est a son auteur seul, proprietaire de l'identite : sur une identite partagee la page se lit, sans liste.
async function Page({ params }: { params: Promise<{ identityPublicId: string }> }) {
    const { identityPublicId } = await params;
    const user = await assertSignedIn();
    const identity = await assertIdentityAccess({ publicId: identityPublicId });
    const isOwner = identity.ownerId === user.id;
    const res = isOwner ? await listCleanupRules(identityPublicId) : null;
    return (
        <SectionCard
            title="Nettoyage automatique"
            description="Une règle envoie à la Corbeille les fils qui correspondent à une recherche, dès que leur message le plus récent dépasse la durée choisie. Les fils étoilés restent, et la Corbeille se vide au bout de 30 jours. Pour créer une règle, lancez une recherche puis choisissez « Nettoyage auto... »."
        >
            {!isOwner ? (
                <div className="rounded-xl border border-dashed border-neutral-300 p-6 text-sm text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                    Seul le propriétaire de cette boîte gère ses règles de nettoyage.
                </div>
            ) : res?.success ? (
                <CleanupRulesList rows={res.data ?? []} />
            ) : (
                <div className="rounded-xl border border-dashed border-red-300 p-6 text-sm text-red-700 dark:border-red-900 dark:text-red-400">
                    {res?.error ?? "Les règles n'ont pas pu être chargées."}
                </div>
            )}
        </SectionCard>
    );
}

export default Page;
