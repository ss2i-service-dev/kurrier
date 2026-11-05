import { isModernUi } from "@/lib/actions/interface-pref";
import KContactForm from "@/components/k/contact-form";
import React from "react";
import NewContactForm from "@/components/dashboard/contacts/new-contact-form";
import { decode } from "decode-formdata";
import { FormState, getPublicEnv, handleAction } from "@schema";
import {getWorkspacePublicId, rlsClient} from "@/lib/actions/clients";
import {
	addressBooks,
	ContactCreate,
	ContactInsertSchema,
	contacts,
} from "@db";
import { isSignedIn } from "@/lib/actions/auth";
import { revalidatePath } from "next/cache";
import {getRedis} from "@/lib/actions/get-redis";

async function ClassicPage({ modern = false }: { modern?: boolean }) {
	const user = await isSignedIn();
	const publicConfig = getPublicEnv();
	const workspacePublicId = await getWorkspacePublicId()
	const createContactAction = async (_prev: FormState, formData: FormData) => {
		"use server";
		return handleAction(async () => {
			const data = decode(formData);
			const rls = await rlsClient();
			const [defaultAddressBook] = await rls((tx) =>
				tx.select().from(addressBooks),
			);

			if (!defaultAddressBook) {
				return {
					success: false,
					error: "No default address book found for user.",
				};
			}
			data.addressBookId = defaultAddressBook.id;

			const res = ContactInsertSchema.safeParse(data);
			if (res.error) {
				return { success: false, error: res.error.message };
			}

			const payload = {
				...decode(formData),
				addressBookId: defaultAddressBook.id,
			};
			const [newContact] = await rls((tx) =>
				tx
					.insert(contacts)
					.values(payload as ContactCreate)
					.returning(),
			);

			const { davQueue } = await getRedis();
			davQueue.add("dav:create-contact", {
				contactId: newContact.id,
				ownerId: newContact.ownerId,
			});

			revalidatePath("/dashboard/contacts/new");
			return { success: true, data: newContact };
		});
	};

	const ContactForm = modern ? KContactForm : NewContactForm;
	return (
		<ContactForm
			createContactAction={createContactAction}
			user={user}
			workspacePublicId={workspacePublicId}
			publicConfig={publicConfig}
		/>
	);
}


// Modern interface: same server action, form in the modern style.
export default async function Page() {
	return <ClassicPage modern={await isModernUi()} />;
}
