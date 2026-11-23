import { redirect } from "next/navigation";

// Scheduled sends now live in the Outbox; old links and bookmarks land there.
async function Page(props: { params: Promise<{ wPublicId: string; identityPublicId: string }> }) {
	const { wPublicId, identityPublicId } = await props.params;
	redirect(`/w/${wPublicId}/dashboard/mail/${identityPublicId}/outbox`);
}

export default Page;
