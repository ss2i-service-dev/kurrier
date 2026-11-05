"use server"

import {cache} from "react";
import {getWorkspaceId, rlsClient, rlsClientForWorkspace} from "@/lib/actions/clients";
import {and, eq, or} from "drizzle-orm";
import {
    db,
    identities,
    workspaceIdentityMembers, workspaceMembers, workspaces,
} from "@db";
import {FormState, handleAction} from "@schema";
import {decode} from "decode-formdata";
import {revalidatePath} from "next/cache";
import {users} from "@db";
import { createHash } from "node:crypto";
import {isSignedIn} from "@/lib/actions/auth";
import {redirect} from "next/navigation";
import {updateWorkSpaceContext} from "@/lib/auth-session";
import {setWorkspaceDefaultIdentity} from "@/lib/workspace-defaults";
import {assertIdentityAccess} from "@/lib/authz";

export const fetchWorkspace = cache(async () => {
    const rls = await rlsClient();
    const [workspace] = await rls(async (tx) => {
        return tx.select().from(workspaces)
    });
    return workspace;
});


export const fetchWorkspaceIdentities = async () => {
    const rls = await rlsClient();
    return await rls((tx) =>
        tx.select().from(workspaceIdentityMembers)
    );
};

export type FetchWorkspaceIdentitiesResult = Awaited<
    ReturnType<typeof fetchWorkspaceIdentities>
>;

export const workspaceIdentityAssignments = async () => {
    const workspace = await fetchWorkspace();

    return await db
        .select({
            workspace_identity_members: workspaceIdentityMembers,
            users: {
                id: users.id,
                email: users.email
            },
        })
        .from(workspaceIdentityMembers)
        .leftJoin(users, eq(workspaceIdentityMembers.userId, users.id))
        .where(eq(workspaceIdentityMembers.workspaceId, workspace.id));
};


export type FetchAdminWorkspaceIdentitiesResult = Awaited<
    ReturnType<typeof workspaceIdentityAssignments>
>;

export const fetchWorkspaces = async () => {
    const user = await isSignedIn();
    const userWorkspaces = await db
        .select().from(workspaces)
        .innerJoin(
            workspaceMembers,
            eq(workspaces.id, workspaceMembers.workspaceId)
        )
        .where(
            eq(workspaceMembers.userId, user?.id || "")
        )
    return userWorkspaces;
};

export type FetchWorkspacesResult = Awaited<
    ReturnType<typeof fetchWorkspaces>
>;

export const fetchWorkspaceMembers = async (id: string) => {
    // Members of a workspace the user belongs to; used to accept any id (member addresses,
    // without sign-in).
    await rlsClientForWorkspace(String(id));
    return await db
        .select({
            workspace_members: workspaceMembers,
            users: {
                id: users.id,
                email: users.email,
                createdAt: users.createdAt,
            },
        })
        .from(workspaceMembers)
        .leftJoin(users, eq(workspaceMembers.userId, users.id))
        .where(eq(workspaceMembers.workspaceId, id));
};

export type FetchWorkspaceMembersResult = Awaited<
    ReturnType<typeof fetchWorkspaceMembers>
>;

export async function toggleDefaultIdentity(
    _prev: FormState,
    formData: FormData,
): Promise<FormState> {
    return handleAction(async () => {
        const decodedForm = decode(formData) as Record<string, unknown>;
        // Visible identity of the user (RLS); the RLS update only filtered on the workspace
        // and could share another user's private identity.
        const identity = await assertIdentityAccess({ id: String(decodedForm.identityId ?? "") });
        await setWorkspaceDefaultIdentity(identity.id);
        revalidatePath("/w/[wPublicId]/dashboard/platform/identities", "page");
        return { success: true };
    });
}


export async function updateWorkspace(
    _prev: FormState,
    formData: FormData,
): Promise<FormState> {
    return handleAction(async () => {
        const decodedForm = decode(formData) as Record<string, unknown>;
        const rls = await rlsClient()
        await rls((tx) =>
            tx.update(workspaces).set({name: String(decodedForm.name)})
        );
        revalidatePath("/w/[wPublicId]/dashboard/platform/workspace", "page");
        return { success: true, message: "Workspace Updated" };
    });
}

function sha256Hex(input: string) {
    return createHash("sha256").update(input).digest("hex");
}


// No caller; not exported (an action that revalidates any path).
const refreshView = async (path: string) => {
    return revalidatePath(path);
};

export const switchWorkSpace = async (workspacePublicId: string, id: string) => {
    // Cookies are only set for a workspace the user owns or belongs to, with its ids
    // re-read from the database.
    const user = await isSignedIn();
    if (!user?.id) throw new Error("Unauthorized");
    const [workspace] = await db
        .select({ id: workspaces.id, publicId: workspaces.publicId })
        .from(workspaces)
        .leftJoin(workspaceMembers, and(
            eq(workspaceMembers.workspaceId, workspaces.id),
            eq(workspaceMembers.userId, user.id),
        ))
        .where(and(
            eq(workspaces.id, String(id)),
            eq(workspaces.publicId, String(workspacePublicId)),
            or(eq(workspaces.ownerId, user.id), eq(workspaceMembers.userId, user.id)),
        ))
        .limit(1);
    if (!workspace) throw new Error("Workspace not found or no access");
    await updateWorkSpaceContext(workspace.publicId, workspace.id, user);
    redirect(`/w/${workspace.publicId}/dashboard/platform/overview`)
};
