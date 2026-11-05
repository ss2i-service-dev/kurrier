import "server-only";

// Default identity of the workspace. These helpers used to be exported by
// lib/actions/workspace.ts ("use server"), hence callable by anyone with any identifier;
// only the server calls them (toggleDefaultIdentity, identity creation), with an
// identity that was already verified.
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
