import "server-only";

// ss2i (controle d'acces) : identite par defaut du workspace. Ces helpers etaient exportes
// par lib/actions/workspace.ts ("use server"), donc appelables par n'importe qui avec
// n'importe quel identifiant ; seul le serveur les appelle (toggleDefaultIdentity, creation
// d'identite), avec une identite deja verifiee.
import { isSignedIn } from "@/lib/actions/auth";
import { rlsClient } from "@/lib/actions/clients";
import { assertWorkspace } from "@/lib/authz";
import { db, identities, workspaces } from "@db";
import { and, eq } from "drizzle-orm";

export const setWorkspaceDefaultIdentity = async (identityId: string) => {
    const rls = await rlsClient();
    const [workspace] = await rls((tx) => tx.select().from(workspaces));
    if (!workspace) return { success: false };

    await rls(async (tx) => {
        await tx.update(identities).set({ sharedWithWorkspace: true }).where(eq(identities.id, identityId));
        await tx
            .update(workspaces)
            .set({ defaultIdentityId: null });
        await tx
            .update(workspaces)
            .set({ defaultIdentityId: identityId })
            .where(eq(workspaces.id, workspace.id));
    });

    return { success: true };
};

export const checkDefaultWorkspaceIdentity = async () => {
    const workspaceId = await assertWorkspace();
    const userId = String((await isSignedIn())?.id);
    const userIdentities = await db.select().from(identities).where(and(
        eq(identities.sharedWithWorkspace, true),
        eq(identities.ownerId, userId),
        eq(identities.workspaceId, workspaceId)
    ))

    if (userIdentities.length === 1) {
        await setWorkspaceDefaultIdentity(userIdentities[0].id);
    }
};
