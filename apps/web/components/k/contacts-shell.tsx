"use client";
// ss2i : zone de travail des contacts (nouvelle interface). Liste a gauche
// (recherche, filtre, groupes par initiale), fiche ou formulaire a droite.
// Sur mobile, une seule colonne a la fois (liste, ou fiche si une route de detail est ouverte).
import React, { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { Search, Star, UserRound, X } from "lucide-react";
import type { ContactWithFavorite } from "@/components/dashboard/contacts/contacts-list";
import KContactAvatar from "@/components/k/contact-avatar";
import MobileNavButton from "@/components/k/mobile-nav-button";
import KNewContactButton from "@/components/k/new-contact-button";
import { KEmptyState } from "@/components/k/section";
import type { KBook } from "@/components/k/contacts-nav";

type ProfileImage = { path: string; signedUrl: string };

const fullName = (c: ContactWithFavorite) => [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export default function KContactsShell({
	children,
	contacts,
	profileImages,
	workspacePublicId,
	books,
	labels,
}: {
	children: React.ReactNode;
	contacts: ContactWithFavorite[];
	profileImages: (ProfileImage | null)[];
	workspacePublicId: string;
	books: KBook[];
	labels: { slug: string; name: string }[];
}) {
	const pathname = usePathname() ?? "";
	const params = useParams() as { contactsPublicId?: string; labelSlug?: string };
	const carnet = useSearchParams().get("carnet");
	const [query, setQuery] = useState("");
	const [onlyFav, setOnlyFav] = useState(false);

	const detail =
		typeof params.contactsPublicId === "string" || pathname.endsWith("/new") || pathname.endsWith("/edit");

	const scoped = useMemo(() => {
		let list = contacts;
		if (params.labelSlug) list = list.filter((c) => c.labels?.includes(params.labelSlug as string));
		if (carnet) list = list.filter((c) => c.addressBookId === carnet);
		return list;
	}, [contacts, params.labelSlug, carnet]);

	const visible = useMemo(() => {
		const q = norm(query.trim());
		const list = scoped.filter((c) => {
			if (onlyFav && !c.isFavorite) return false;
			if (!q) return true;
			const hay = norm(
				[fullName(c), c.company, c.jobTitle, ...(c.emails ?? []).map((e) => e?.address)].filter(Boolean).join(" "),
			);
			return hay.includes(q);
		});
		return [...list].sort((a, b) =>
			(fullName(a) || a.emails?.[0]?.address || "").localeCompare(fullName(b) || b.emails?.[0]?.address || "", "fr"),
		);
	}, [scoped, query, onlyFav]);

	const groups = useMemo(() => {
		const map = new Map<string, ContactWithFavorite[]>();
		for (const c of visible) {
			const key = (fullName(c) || c.emails?.[0]?.address || "#")[0].toUpperCase();
			const k = /\p{L}/u.test(key) ? norm(key).toUpperCase() : "#";
			map.set(k, [...(map.get(k) ?? []), c]);
		}
		return Array.from(map.entries());
	}, [visible]);

	const title = params.labelSlug
		? (labels.find((l) => l.slug === params.labelSlug)?.name ?? "Libellé")
		: carnet
			? (books.find((b) => b.id === carnet)?.name ?? "Carnet d'adresses")
			: "Tous les contacts";

	const base = `/w/${workspacePublicId}/dashboard/contacts`;
	const hrefFor = (c: ContactWithFavorite) =>
		params.labelSlug ? `${base}/label/${params.labelSlug}/contact/${c.publicId}` : `${base}/${c.publicId}`;
	const imageOf = (c: ContactWithFavorite) =>
		c.profilePictureXs
			? (profileImages.find((img) => img?.path?.includes(c.profilePictureXs as string))?.signedUrl ?? null)
			: null;

	const segBtn = (active: boolean) =>
		`rounded-[5px] px-2.5 py-1 transition-colors ${
			active ? "bg-k-surface font-medium text-k-ink shadow-k-pane" : "text-k-ink-2 hover:text-k-ink"
		}`;

	return (
		<div className="flex min-h-0 flex-1">
			<section
				aria-label="Liste des contacts"
				className={`${detail ? "hidden lg:flex" : "flex"} w-full min-w-0 flex-col border-k-line lg:w-[360px] lg:shrink-0 lg:border-r xl:w-[400px]`}
			>
				<div className="flex h-12 shrink-0 items-center gap-2 px-3">
					<MobileNavButton />
					<h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-k-ink">
						{title}
						<span className="ml-2 text-[13px] font-normal text-k-ink-3">{scoped.length}</span>
					</h1>
					<div className="flex rounded-k-sm bg-k-hover p-0.5 text-[12.5px]">
						<button type="button" onClick={() => setOnlyFav(false)} className={segBtn(!onlyFav)}>
							Tous
						</button>
						<button type="button" onClick={() => setOnlyFav(true)} className={segBtn(onlyFav)}>
							Favoris
						</button>
					</div>
				</div>

				<div className="shrink-0 px-3 pb-2">
					<label className="flex h-9 items-center gap-2 rounded-k bg-k-hover px-2.5 text-k-ink-3 focus-within:bg-k-surface focus-within:shadow-[0_0_0_1.5px_var(--k-accent)]">
						<Search size={15} className="shrink-0" />
						<input
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Rechercher un contact"
							aria-label="Rechercher un contact"
							className="min-w-0 flex-1 bg-transparent text-[13.5px] text-k-ink outline-none placeholder:text-k-ink-3 [&::-webkit-search-cancel-button]:hidden"
						/>
						{query && (
							<button type="button" onClick={() => setQuery("")} aria-label="Effacer la recherche" className="text-k-ink-3 hover:text-k-ink">
								<X size={14} />
							</button>
						)}
					</label>
				</div>

				<div className="k-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-4">
					{visible.length === 0 ? (
						<KEmptyState
							icon={<UserRound size={22} strokeWidth={1.6} />}
							title={query || onlyFav ? "Aucun résultat" : "Aucun contact"}
							text={
								query || onlyFav
									? "Aucun contact ne correspond à votre recherche."
									: params.labelSlug || carnet
										? "Ce regroupement ne contient pas encore de contact."
										: "Ajoutez votre premier contact pour le retrouver ici."
							}
						/>
					) : (
						groups.map(([letter, items]) => (
							<div key={letter}>
								<div className="sticky top-0 z-[1] bg-k-surface px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-k-ink-3">
									{letter}
								</div>
								<ul className="space-y-px">
									{items.map((c) => {
										const active = c.publicId === params.contactsPublicId;
										const name = fullName(c);
										const email = c.emails?.[0]?.address ?? "";
										return (
											<li key={c.id}>
												<Link
													href={hrefFor(c)}
													aria-current={active ? "true" : undefined}
													className={`flex items-center gap-3 rounded-k px-3 py-2 transition-colors ${
														active ? "bg-k-selected" : "hover:bg-k-hover"
													}`}
												>
													<KContactAvatar name={name} email={email} url={imageOf(c)} size={36} />
													<div className="min-w-0 flex-1">
														<div className="truncate text-[14px] font-medium text-k-ink">{name || email || "Sans nom"}</div>
														<div className="truncate text-[12.5px] text-k-ink-3">
															{email || [c.jobTitle, c.company].filter(Boolean).join(" · ")}
														</div>
													</div>
													{c.isFavorite && <Star size={13} className="shrink-0 fill-k-star text-k-star" />}
												</Link>
											</li>
										);
									})}
								</ul>
							</div>
						))
					)}
				</div>

				<div className="shrink-0 border-t border-k-line p-3 lg:hidden">
					<KNewContactButton workspacePublicId={workspacePublicId} />
				</div>
			</section>

			<section
				aria-label="Fiche du contact"
				className={`${detail ? "flex" : "hidden lg:flex"} min-w-0 flex-1 flex-col`}
			>
				{children}
			</section>
		</div>
	);
}
