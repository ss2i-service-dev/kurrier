"use client";

import * as React from "react";
import Link from "next/link";
import { ReusableForm } from "@/components/common/reusable-form";
import { Building, Cake, ChevronLeft, Mail, MapPinPlus, Phone, Plus, StickyNote, Camera, UserRound } from "lucide-react";
import KAvatar from "@/components/k/avatar";
import ReusableFormCustomWrapper from "@/components/common/reusable-form-custom-wrapper";
import { DatePickerInput } from "@mantine/dates";
import { getCountryDataList, getEmojiFlag, TCountryCode } from "countries-list";
import { FieldConfig, FormState, PublicConfig } from "@schema";
import { createThumbnail } from "@/lib/utils";
import { nanoid } from "nanoid";
import { extension } from "mime-types";
import { useRouter } from "next/navigation";
import { ContactEntity } from "@db";
import {uploadContactProfileAction} from "@/lib/actions/uploads-actions";
import {FetchIsSignedInResult} from "@/lib/actions/auth";

function Heading({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
	return (
		<div className="mt-5 flex items-center gap-2 border-t border-k-line pt-5 text-[12px] font-semibold uppercase tracking-[0.06em] text-k-ink-3">
			{icon}
			{children}
		</div>
	);
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="k-focus inline-flex h-8 items-center gap-1.5 rounded-k-sm px-2 text-[13px] font-medium text-k-accent transition-colors hover:bg-k-accent-soft"
		>
			<Plus size={15} />
			{children}
		</button>
	);
}

function RemoveButton({ onClick }: { onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="text-[12.5px] text-k-ink-3 hover:text-k-danger hover:underline">
			Remove
		</button>
	);
}

// Contact create / edit form (modern interface). Same fields, same field names
// and same actions as new-contact-form.tsx.
export default function KContactForm({
	contact = null,
	profilePictureUrl,
	createContactAction,
	workspacePublicId,
	user,
	publicConfig,
}: {
	contact?: ContactEntity | null;
	profilePictureUrl?: string | null;
	createContactAction: (
		_prev: FormState,
		formData: FormData,
	) => Promise<FormState>;
	user: FetchIsSignedInResult;
	workspacePublicId: string;
	publicConfig: PublicConfig;
}) {
	const [preview, setPreview] = React.useState<string | null>(
		profilePictureUrl ?? null,
	);
	const fileRef = React.useRef<HTMLInputElement>(null);

	const [emailRows, setEmailRows] = React.useState<number[]>(() =>
		contact?.emails?.length ? contact.emails.map((_, i) => i) : [],
	);

	const [phoneRows, setPhoneRows] = React.useState<number[]>(() =>
		contact?.phones?.length ? contact.phones.map((_, i) => i) : [],
	);

	const [addressRows, setAddressRows] = React.useState<number[]>(() =>
		contact?.addresses?.length ? contact.addresses.map((_, i) => i) : [],
	);

	const newContactPublicId = React.useRef(contact?.publicId ?? nanoid(10));

	const countryPhoneOptions = React.useMemo(() => {
		const list = getCountryDataList();
		return list
			.map((listItem) => {
				const emoji = getEmojiFlag(listItem.iso2 as TCountryCode) || "";
				return {
					value: listItem.iso2,
					label: `${emoji} ${listItem.name} (+${listItem.phone[0]})`,
				};
			})
			.filter(Boolean) as { value: string; label: string }[];
	}, []);

	const countryOptions = React.useMemo(() => {
		const list = getCountryDataList();
		return list
			.map((listItem) => {
				const emoji = getEmojiFlag(listItem.iso2 as TCountryCode) || "";
				return {
					value: listItem.iso2,
					label: `${emoji} ${listItem.name}`,
				};
			})
			.filter(Boolean) as { value: string; label: string }[];
	}, []);

	const handleFileSelect = async (
		event: React.ChangeEvent<HTMLInputElement>,
	) => {
		const file = event.target.files?.[0];
		if (!file || !user) return;

		const base64 = (await createThumbnail(file, "dataUrl", 512, 0.2)) as string;
		setPreview(base64);

		const basePath = `private/${user.id}/contacts/${newContactPublicId.current}`;
		const ext = (extension(file.type) || "jpg").toString();

		const mainPath = `${basePath}/${nanoid(12)}.${ext}`;
		const thumbPath = `${basePath}/${nanoid(12)}_xs.${ext}`;

		const mainFile = (await createThumbnail(file, "file", 1920, 1)) as File;
		const thumbFile = (await createThumbnail(file, "file", 128, 0.2)) as File;

		try {
			await uploadContactProfileAction({
				mainFile,
				thumbFile,
				mainPath,
				thumbPath,
			});

			const profileField = document.querySelector(
				"input[name='profilePicture']",
			) as HTMLInputElement | null;

			const profileXsField = document.querySelector(
				"input[name='profilePictureXs']",
			) as HTMLInputElement | null;

			const publicIdField = document.querySelector(
				"input[name='publicId']",
			) as HTMLInputElement | null;

			if (profileField) profileField.value = mainPath;
			if (profileXsField) profileXsField.value = thumbPath;
			if (publicIdField) publicIdField.value = newContactPublicId.current;

		} catch (err) {
			console.error("Upload failed", err);
		}
	};

	const addEmailRow = () => {
		setEmailRows((rows) => [
			...rows,
			rows.length === 0 ? 0 : rows[rows.length - 1] + 1,
		]);
	};

	const removeEmailRow = (id: number) => {
		setEmailRows((rows) => rows.filter((r) => r !== id));
	};

	const addPhoneRow = () => {
		setPhoneRows((rows) => [
			...rows,
			rows.length === 0 ? 0 : rows[rows.length - 1] + 1,
		]);
	};

	const removePhoneRow = (id: number) => {
		setPhoneRows((rows) => rows.filter((r) => r !== id));
	};

	const addAddressRow = () => {
		setAddressRows((rows) => [
			...rows,
			rows.length === 0 ? 0 : rows[rows.length - 1] + 1,
		]);
	};

	const removeAddressRow = (id: number) => {
		setAddressRows((rows) => rows.filter((r) => r !== id));
	};

	const emails = contact?.emails ?? [];
	const phones = contact?.phones ?? [];
	const addresses = contact?.addresses ?? [];

	const fields: FieldConfig[] = [
		{
			el: (
				<div className="flex items-center gap-4">
					<input type="file" accept="image/*" className="hidden" ref={fileRef} onChange={handleFileSelect} />
					<input type="hidden" name="addressBookId" value={contact?.addressBookId ?? ""} />
					<button
						type="button"
						onClick={() => fileRef.current?.click()}
						className="k-focus group relative h-20 w-20 shrink-0 overflow-hidden rounded-full"
						aria-label="Change photo"
					>
						{preview || profilePictureUrl ? (
							// eslint-disable-next-line @next/next/no-img-element
							<img src={(preview || profilePictureUrl) as string} alt="" className="h-20 w-20 object-cover object-top" />
						) : (
							contact ? (
								<KAvatar name={[contact.firstName, contact.lastName].filter(Boolean).join(" ")} email={contact.emails?.[0]?.address} size={80} />
							) : (
								<span className="flex h-20 w-20 items-center justify-center rounded-full bg-k-hover text-k-ink-3">
									<UserRound size={30} strokeWidth={1.5} />
								</span>
							)
						)}
						<span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100">
							<Camera size={20} />
						</span>
					</button>
					<div className="text-[13px] text-k-ink-3">
						<button type="button" onClick={() => fileRef.current?.click()} className="font-medium text-k-accent hover:underline">
							{preview || profilePictureUrl ? "Change photo" : "Add photo"}
						</button>
						<p>A square image works best.</p>
					</div>
					<input type="hidden" name="profilePicture" defaultValue={contact?.profilePicture || ""} />
					<input type="hidden" name="profilePictureXs" defaultValue={contact?.profilePictureXs || ""} />
				</div>
			),
			wrapperClasses: "col-span-12",
		},

		{
			name: "firstName",
			label: "First name",
			wrapperClasses: "col-span-12 md:col-span-6",
			props: { required: true, defaultValue: contact?.firstName || "" },
		},
		{
			name: "lastName",
			label: "Last name",
			wrapperClasses: "col-span-12 md:col-span-6",
			props: { defaultValue: contact?.lastName || "" },
		},

		{ wrapperClasses: "col-span-12", el: <Heading icon={<Building size={14} />}>Organization</Heading> },
		{
			name: "company",
			label: "Company",
			wrapperClasses: "col-span-12 md:col-span-6",
			props: { defaultValue: contact?.company || "" },
		},
		{
			name: "jobTitle",
			label: "Job title",
			wrapperClasses: "col-span-12 md:col-span-6",
			props: { defaultValue: contact?.jobTitle || "" },
		},
		{
			name: "department",
			label: "Department",
			wrapperClasses: "col-span-12 md:col-span-6",
			props: { defaultValue: contact?.department || "" },
		},

		{ wrapperClasses: "col-span-12", el: <Heading icon={<Mail size={14} />}>Email</Heading> },

		...emailRows.flatMap<FieldConfig>((id, index) => [
			{
				name: `emails.${id}.address`,
				label: index === 0 ? "Email address" : `Email address ${index + 1}`,
				wrapperClasses: "col-span-12",
				props: { type: "email", defaultValue: emails[id]?.address ?? "" },
				bottomEndSuffix: emailRows.length > 1 ? <RemoveButton onClick={() => removeEmailRow(id)} /> : undefined,
			},
		]),
		{
			wrapperClasses: "col-span-12",
			el: <AddButton onClick={addEmailRow}>Add an email address</AddButton>,
		},

		{ wrapperClasses: "col-span-12", el: <Heading icon={<Phone size={14} />}>Phone</Heading> },

		...phoneRows.flatMap<FieldConfig>((id, index) => [
			{
				name: `phones.${id}.code`,
				label: "Country",
				wrapperClasses: "col-span-12 sm:col-span-5",
				kind: "select",
				options: countryPhoneOptions,
				props: { className: "w-full", searchable: true, defaultValue: phones[id]?.code ?? "" },
			},
			{
				name: `phones.${id}.number`,
				label: index === 0 ? "Number" : `Number ${index + 1}`,
				wrapperClasses: "col-span-12 sm:col-span-7",
				props: { required: index === 0, defaultValue: phones[id]?.number ?? "" },
				bottomEndSuffix: phoneRows.length > 1 ? <RemoveButton onClick={() => removePhoneRow(id)} /> : undefined,
			},
		]),
		{
			wrapperClasses: "col-span-12",
			el: <AddButton onClick={addPhoneRow}>Add a number</AddButton>,
		},

		{ wrapperClasses: "col-span-12", el: <Heading icon={<MapPinPlus size={14} />}>Postal address</Heading> },

		...addressRows.flatMap<FieldConfig>((id, index) => [
			{
				name: `addresses.${id}.country`,
				label: index === 0 ? "Country" : `Country (${index + 1})`,
				wrapperClasses: "col-span-12",
				kind: "select",
				options: countryOptions,
				props: { className: "w-full", searchable: true, defaultValue: addresses[id]?.country ?? "" },
			},
			{
				name: `addresses.${id}.streetAddress`,
				label: "Address",
				wrapperClasses: "col-span-12",
				props: { defaultValue: addresses[id]?.streetAddress ?? "" },
			},
			{
				name: `addresses.${id}.streetAddressLine2`,
				label: "Address line 2",
				wrapperClasses: "col-span-12",
				props: { defaultValue: addresses[id]?.streetAddressLine2 ?? "" },
			},
			{
				name: `addresses.${id}.city`,
				label: "City",
				wrapperClasses: "col-span-12 sm:col-span-6",
				props: { defaultValue: addresses[id]?.city ?? "" },
			},
			{
				name: `addresses.${id}.state`,
				label: "State / region",
				wrapperClasses: "col-span-6 sm:col-span-3",
				props: { defaultValue: addresses[id]?.state ?? "" },
			},
			{
				name: `addresses.${id}.code`,
				label: "Postal code",
				wrapperClasses: "col-span-6 sm:col-span-3",
				bottomEndSuffix: addressRows.length > 1 ? <RemoveButton onClick={() => removeAddressRow(id)} /> : undefined,
				props: { defaultValue: addresses[id]?.code ?? "" },
			},
		]),
		{
			wrapperClasses: "col-span-12",
			el: <AddButton onClick={addAddressRow}>Add an address</AddButton>,
		},

		{ wrapperClasses: "col-span-12", el: <Heading icon={<Cake size={14} />}>Birthday</Heading> },
		{
			name: "dob",
			wrapperClasses: "col-span-12 md:col-span-6",
			kind: "custom",
			component: ReusableFormCustomWrapper,
			props: {
				component: DatePickerInput,
				placeholder: "Pick a date",
				defaultValue: contact?.dob ? contact.dob : null,
			},
		},

		{ wrapperClasses: "col-span-12", el: <Heading icon={<StickyNote size={14} />}>Notes</Heading> },
		{
			name: "notes",
			wrapperClasses: "col-span-12",
			kind: "textarea",
			props: { rows: 4, autosize: true, minRows: 4, defaultValue: contact?.notes || "" },
		},
	];

	const router = useRouter();
	const backHref = contact
		? `/w/${workspacePublicId}/dashboard/contacts/${contact.publicId}`
		: `/w/${workspacePublicId}/dashboard/contacts`;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-12 shrink-0 items-center gap-2 px-3">
				<Link
					href={backHref}
					aria-label="Back"
					className="inline-flex h-8 items-center gap-1 rounded-k-sm pr-2 text-[13px] text-k-ink-2 hover:bg-k-hover hover:text-k-ink"
				>
					<ChevronLeft size={17} /> {contact ? "Contact" : "Contacts"}
				</Link>
			</div>
			<div className="k-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-10 sm:px-8">
				<div className="mx-auto max-w-2xl">
					<h1 className="mb-5 mt-1 text-[20px] font-semibold tracking-tight text-k-ink">
						{contact
							? `Edit ${[contact.firstName, contact.lastName].filter(Boolean).join(" ")}`
							: "New contact"}
					</h1>
					<ReusableForm
						fields={fields}
						action={createContactAction}
						formWrapperClasses="grid grid-cols-12 gap-x-4 gap-y-3"
						submitButtonProps={{
							submitLabel: contact ? "Save changes" : "Create contact",
							wrapperClasses: "mt-8 flex justify-end gap-2 border-t border-k-line pt-5",
							fullWidth: false,
						}}
						onSuccess={(newContact) =>
							router.push(`/w/${workspacePublicId}/dashboard/contacts/${newContact.publicId}`)
						}
					/>
				</div>
			</div>
		</div>
	);
}
