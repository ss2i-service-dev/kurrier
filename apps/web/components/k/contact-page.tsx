// Contact card (modern interface). Same data and actions as the classic page;
// modern presentation (header, contact details, addresses, notes).
import React from "react";
import Link from "next/link";
import Form from "next/form";
import { eq } from "drizzle-orm";
import { contacts } from "@db";
import { revalidatePath } from "next/cache";
import { ChevronLeft, Cake, Mail, MapPin, Pencil, Phone, StickyNote, Star, UserRound } from "lucide-react";
import { getCountryDataList, TCountryCode } from "countries-list";
import { LabelScope } from "@schema";
import { generateSignedUrl } from "@common";
import { getWorkspacePublicId, rlsClient } from "@/lib/actions/clients";
import { getRedis } from "@/lib/actions/get-redis";
import { isSignedIn } from "@/lib/actions/auth";
import { fetchContactLabelsByContactIds, fetchLabels, toggleFavoriteContact } from "@/lib/actions/labels";
import { ContactLabelHoverButtons } from "@/components/dashboard/labels/contact-label-hover-buttons";
import KContactAvatar from "@/components/k/contact-avatar";
import KDeleteContactButton from "@/components/k/delete-contact-button";
import KIconButton from "@/components/k/icon-button";
import { KEmptyState } from "@/components/k/section";

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
	return (
		<section className="rounded-k border border-k-line bg-k-surface">
			<h2 className="flex items-center gap-2 border-b border-k-line px-4 py-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-k-ink-3">
				{icon}
				{title}
			</h2>
			<div className="divide-y divide-k-line">{children}</div>
		</section>
	);
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5 px-4 py-2.5 sm:flex-row sm:items-baseline sm:gap-4">
			<div className="w-28 shrink-0 text-[12.5px] text-k-ink-3">{label}</div>
			<div className="min-w-0 flex-1 break-words text-[14px] text-k-ink">{children}</div>
		</div>
	);
}

export default async function KContactPage({
	params,
}: {
	params: Promise<{ contactsPublicId: string; labelSlug?: string }>;
}) {
	const { contactsPublicId, labelSlug } = await params;
	const rls = await rlsClient();
	const workspacePublicId = await getWorkspacePublicId();
	const listHref = `/w/${workspacePublicId}/dashboard/contacts${labelSlug ? `/label/${labelSlug}` : ""}`;

	const [contact] = await rls((tx) => tx.select().from(contacts).where(eq(contacts.publicId, contactsPublicId)));

	if (!contact) {
		return (
			<div className="flex flex-1 flex-col">
				<Link href={listHref} className="m-3 inline-flex items-center gap-1 text-[13px] text-k-ink-2 hover:text-k-ink lg:hidden">
					<ChevronLeft size={16} /> Contacts
				</Link>
				<KEmptyState icon={<UserRound size={22} strokeWidth={1.6} />} title="Contact not found" text="This contact no longer exists or has been deleted." />
			</div>
		);
	}

	const emails = Array.isArray(contact.emails) ? contact.emails : [];
	const phones = Array.isArray(contact.phones) ? contact.phones : [];
	const addresses = Array.isArray(contact.addresses) ? contact.addresses : [];
	const profilePictureUrl = contact.profilePicture ? await generateSignedUrl(contact.profilePicture) : null;

	const onDeleteAction = async (id: string) => {
		"use server";
		const { davQueue } = await getRedis();
		const user = await isSignedIn();
		await davQueue.add("dav:delete-contact", { contactId: id, ownerId: user?.id });
		const rls = await rlsClient();
		await rls((tx) => tx.delete(contacts).where(eq(contacts.id, id)));
		revalidatePath("/dashboard/contacts");
		return { success: true };
	};

	const [allLabels, labelsByContactId] = await Promise.all([
		fetchLabels("contact" as LabelScope),
		fetchContactLabelsByContactIds([contact.id]),
	]);
	const isFavorite = labelsByContactId[contact.id]?.some((entry) => entry.label.name === "Favorite");
	const shownLabels = labelsByContactId[contact.id]?.filter((l) => l.label.name !== "Favorite") || [];

	const phoneByCountry = new Map<string, string>(
		getCountryDataList().map((c) => [c.iso2, String(c.phone).split(",")[0].trim()]),
	);
	function formatPhone(p: any) {
		if (!p?.number) return null;
		const code = p.countryCode || p.code;
		const prefix = code && phoneByCountry.has(code as TCountryCode) ? `+${phoneByCountry.get(code as TCountryCode)} ` : "";
		return `${prefix}${p.number}`;
	}
	function formatDob(dob?: string | null) {
		if (!dob) return null;
		const d = new Date(dob);
		if (Number.isNaN(d.getTime())) return dob;
		return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
	}

	const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
	const dob = formatDob(contact.dob);
	const shownAddresses = addresses
		.map((addr) =>
			[
				[addr.streetAddress, addr.streetAddressLine2].filter(Boolean).join(", "),
				[addr.code, addr.city].filter(Boolean).join(" "),
				[addr.state, addr.country].filter(Boolean).join(", "),
			]
				.filter((l) => l && l.trim().length > 0)
				.join("\n"),
		)
		.filter(Boolean);
	const hasNotes = !!contact.notes && contact.notes.trim().length > 0;
	const hasDetails = emails.some((e) => e?.address) || phones.some((p) => p?.number) || !!dob;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-12 shrink-0 items-center gap-1 px-3">
				<Link
					href={listHref}
					className="inline-flex h-8 items-center gap-1 rounded-k-sm pr-2 text-[13px] text-k-ink-2 hover:bg-k-hover hover:text-k-ink lg:hidden"
				>
					<ChevronLeft size={17} /> Contacts
				</Link>
				<span className="flex-1" />
				<Link
					href={`/w/${workspacePublicId}/dashboard/contacts/${contact.publicId}/edit`}
					className="k-focus inline-flex h-8 items-center gap-1.5 rounded-k-sm px-2.5 text-[13px] text-k-ink-2 transition-colors hover:bg-k-hover hover:text-k-ink"
				>
					<Pencil size={15} /> Edit
				</Link>
				<KDeleteContactButton contact={contact} workspacePublicId={workspacePublicId} onDeleteAction={onDeleteAction} />
			</div>

			<div className="k-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-8 sm:px-8">
				<div className="mx-auto max-w-2xl space-y-5">
					<header className="flex items-center gap-4 pt-2">
						<KContactAvatar name={name} email={emails[0]?.address} url={profilePictureUrl} size={72} />
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5">
								<h1 className="truncate text-[22px] font-semibold tracking-tight text-k-ink">{name || "No name"}</h1>
								<Form action={toggleFavoriteContact} className="shrink-0">
									<input name="contactId" type="hidden" value={contact.id} />
									<KIconButton
										type="submit"
										label={isFavorite ? "Remove from favorites" : "Add to favorites"}
										tone={isFavorite ? "accent" : "default"}
									>
										<Star className={isFavorite ? "fill-k-star text-k-star" : ""} />
									</KIconButton>
								</Form>
							</div>
							{(contact.jobTitle || contact.company) && (
								<p className="truncate text-[14px] text-k-ink-2">
									{[contact.jobTitle, contact.company].filter(Boolean).join(" · ")}
								</p>
							)}
							{contact.department && <p className="truncate text-[13px] text-k-ink-3">{contact.department}</p>}
						</div>
					</header>

					<div className="flex flex-wrap items-center gap-1.5">
						{shownLabels.map((entry) => (
							<span
								key={entry.label.id}
								className="inline-flex items-center gap-1.5 rounded-full bg-k-hover px-2.5 py-1 text-[12px] text-k-ink-2"
							>
								<span className="h-2 w-2 rounded-full" style={{ background: entry.label.colorBg ?? "#64748b" }} />
								{entry.label.name}
							</span>
						))}
						<ContactLabelHoverButtons contact={contact} allLabels={allLabels} labelsByContactId={labelsByContactId} />
					</div>

					{hasDetails && (
						<Section icon={<Mail size={14} />} title="Contact details">
							{emails.map((e, i) =>
								e?.address ? (
									<Row key={`e${i}`} label={i === 0 ? "Email" : `Email ${i + 1}`}>
										<a href={`mailto:${e.address}`} className="text-k-accent hover:underline">
											{e.address}
										</a>
									</Row>
								) : null,
							)}
							{phones.map((p, i) =>
								p?.number ? (
									<Row key={`p${i}`} label={i === 0 ? "Phone" : `Phone ${i + 1}`}>
										<span className="inline-flex items-center gap-1.5">
											<Phone size={13} className="text-k-ink-3" />
											{formatPhone(p)}
										</span>
									</Row>
								) : null,
							)}
							{dob && (
								<Row label="Birthday">
									<span className="inline-flex items-center gap-1.5">
										<Cake size={13} className="text-k-ink-3" />
										{dob}
									</span>
								</Row>
							)}
						</Section>
					)}

					{shownAddresses.length > 0 && (
						<Section icon={<MapPin size={14} />} title="Addresses">
							{shownAddresses.map((lines, i) => (
								<Row key={i} label={shownAddresses.length > 1 ? `Address ${i + 1}` : "Address"}>
									<span className="whitespace-pre-line">{lines}</span>
								</Row>
							))}
						</Section>
					)}

					{hasNotes && (
						<Section icon={<StickyNote size={14} />} title="Notes">
							<div className="whitespace-pre-line px-4 py-3 text-[14px] leading-relaxed text-k-ink">{contact.notes}</div>
						</Section>
					)}

					{!hasDetails && shownAddresses.length === 0 && !hasNotes && (
						<p className="rounded-k bg-k-surface-2 px-4 py-6 text-center text-[13px] text-k-ink-3">
							No contact details yet. Use "Edit" to complete this card.
						</p>
					)}
				</div>
			</div>
		</div>
	);
}
