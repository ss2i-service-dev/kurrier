import { redirect } from "next/navigation";

// ss2i : les envois programmes sont dans la Boite d'envoi (OI 10519) ; anciens liens et favoris.
async function Page(props: { params: Promise<{ wPublicId: string; identityPublicId: string }> }) {
	const { wPublicId, identityPublicId } = await props.params;
	redirect(`/w/${wPublicId}/dashboard/mail/${identityPublicId}/outbox`);
}

export default Page;
