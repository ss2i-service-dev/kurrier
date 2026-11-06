"use server";
// ss2i : agenda Outlook dans courrier, en remplacement d'Outlook, tout par Microsoft Graph
// (page Agenda et fenetre « Ajouter a l'agenda »). Rien n'est garde dans courrier : chaque
// lecture et chaque ecriture va a Graph, Outlook voit tout aussitot.
// Boites lisibles : identites de l'utilisateur (connexion RLS : une identite d'un autre
// utilisateur n'existe pas) presentes dans BRIDGE_MAILBOXES. Sources affichees : les agendas
// de la boite, et les agendas des collegues partages avec elle ; le droit sur un agenda de
// collegue est relu sur Graph cote serveur a chaque appel (cache 5 min), jamais pris du
// navigateur, et ce qui est rendu est reduit selon ce droit.
import { and, eq } from "drizzle-orm";
import { identities } from "@db";
import { getServerEnv } from "@schema";
import {
	AgendaError,
	type AgendaEvent,
	type GraphConfig,
	addDays,
	createGraphEvent,
	graphEventBody,
	normalizeAgendaEvent,
	parseMailboxList,
} from "@common/thread-agenda";
import { type CalendarEvent, checkRange, safeTimeZone, utcToZoned } from "@common/outlook-calendar";
import {
	ATTACHMENT_MAX_BYTES,
	type CalendarRole,
	type DueReminder,
	type EventDetail,
	type EventScope,
	type InviteResponse,
	type NewAttachment,
	type OutlookCategory,
	ROLE_LABEL,
	type Room,
	type Schedule,
	type TeamsOptions,
	addAttachment,
	calendarRole,
	canEditRole,
	canSeeDetails,
	canSeePrivate,
	createCategory,
	createEvent,
	deleteEvent,
	dismissReminder,
	eventJoinUrl,
	forwardEvent,
	getAttachment,
	getEvent,
	getSchedules,
	getTeamsOptions,
	listCalendarEvents,
	listCalendars,
	listCategories,
	listReminders,
	listRooms,
	moveEvent,
	normalizeEventInput,
	redactForRole,
	removeAttachment,
	respondToEvent,
	sharedCalendarOwners,
	snoozeReminder,
	updateEvent,
	updateTeamsOptions,
} from "@common/outlook-graph";
import { rlsClient } from "@/lib/actions/clients";
import { demo } from "@/lib/outlook-demo";

export type OutlookCalendarBox = { identityPublicId: string; address: string; displayName: string | null };

/** Ce que le navigateur designe : un agenda de la boite, ou l'agenda d'un collegue. */
export type SourceRef = { kind: "own"; calendarId?: string } | { kind: "colleague"; owner: string };

export type CalendarSource = SourceRef & {
	key: string;
	name: string;
	color: string;
	role: CalendarRole;
	roleLabel: string;
	editable: boolean;
	isDefault?: boolean;
};

export type OutlookEventsResult = { ok: true; mailbox: string; events: CalendarEvent[]; errors?: string[] } | { ok: false; error: string };
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const keyOf = (s: SourceRef) => (s.kind === "own" ? `own:${s.calendarId ?? "default"}` : `colleague:${String(s.owner).toLowerCase()}`);

const COLLEAGUE_COLORS = ["#7a6ad8", "#3fb5ad", "#e57399", "#b0835a", "#5fb35f", "#f0a14b"];

function graphConfig(): GraphConfig {
	const env = getServerEnv();
	const missing = (["GRAPH_TENANT", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "BRIDGE_MAILBOXES"] as const).filter((k) => !env[k]?.trim());
	if (missing.length) {
		throw new AgendaError(
			`Agenda Outlook non configuré sur le serveur : ${missing.length > 1 ? "variables manquantes" : "variable manquante"} ${missing.join(", ")} (service web).`,
		);
	}
	return { tenant: String(env.GRAPH_TENANT).trim(), clientId: String(env.GRAPH_CLIENT_ID).trim(), clientSecret: String(env.GRAPH_CLIENT_SECRET).trim() };
}

/** Adresse d'une identite de l'utilisateur, si son agenda Outlook est accessible. */
async function boxAddress(identityPublicId: string): Promise<string> {
	const rls = await rlsClient();
	const [ident] = await rls((tx) =>
		tx
			.select({ value: identities.value })
			.from(identities)
			.where(and(eq(identities.publicId, String(identityPublicId)), eq(identities.kind, "email")))
			.limit(1),
	);
	if (!ident) throw new AgendaError("Boîte introuvable.");
	const address = ident.value.trim().toLowerCase();
	if (demo.on()) return address;
	if (!parseMailboxList(getServerEnv().BRIDGE_MAILBOXES).includes(address)) {
		throw new AgendaError(`${address} n'est pas une boîte Microsoft 365 du tenant (BRIDGE_MAILBOXES) : son agenda Outlook n'est pas accessible.`);
	}
	return address;
}

// Droit sur l'agenda d'un collegue, relu sur Graph au plus toutes les 30 minutes (calendarPermissions
// repond en 2 s environ : c'etait l'essentiel du temps d'ouverture de l'agenda).
const roles = new Map<string, { at: number; role: CalendarRole }>();
async function roleFor(cfg: GraphConfig | null, owner: string, me: string): Promise<CalendarRole> {
	const k = `${me}>${owner}`;
	const hit = roles.get(k);
	if (hit && Date.now() - hit.at < 30 * 60_000) return hit.role;
	const role = demo.on() ? demo.role(owner, me) : await calendarRole(cfg as GraphConfig, owner, me);
	roles.set(k, { at: Date.now(), role });
	return role;
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;

/** Boite a interroger pour une source, et droit de l'utilisateur dessus (verifie ici). */
async function resolve(me: string, ref: SourceRef): Promise<{ cfg: GraphConfig | null; mailbox: string; calendarId?: string; role: CalendarRole }> {
	const cfg = demo.on() ? null : graphConfig();
	if (ref?.kind === "colleague") {
		const owner = String(ref.owner ?? "").trim().toLowerCase();
		if (!EMAIL_RE.test(owner)) throw new AgendaError("Adresse du collègue invalide.");
		const role = await roleFor(cfg, owner, me);
		if (role === "none") throw new AgendaError(`${owner} ne partage pas son agenda avec vous.`);
		return { cfg, mailbox: owner, role };
	}
	const calendarId = ref?.kind === "own" && ref.calendarId ? String(ref.calendarId) : undefined;
	return { cfg, mailbox: me, calendarId, role: "delegateWithPrivateEventAccess" };
}

const failure = (where: string, err: unknown) => {
	if (err instanceof AgendaError) return { ok: false as const, error: err.message };
	console.error(`[outlook-calendar] ${where}`, err);
	return { ok: false as const, error: "Erreur inattendue, voir le journal du serveur." };
};

/** Boites de l'utilisateur dont l'agenda Outlook est lisible (vide si rien n'est configure). */
export async function outlookCalendarBoxes(): Promise<OutlookCalendarBox[]> {
	try {
		const on = demo.on();
		const boxes = parseMailboxList(getServerEnv().BRIDGE_MAILBOXES);
		if (!boxes.length && !on) return [];
		const rls = await rlsClient();
		const rows = await rls((tx) =>
			tx
				.select({ publicId: identities.publicId, value: identities.value, displayName: identities.displayName })
				.from(identities)
				.where(eq(identities.kind, "email")),
		);
		const seen = new Set<string>();
		return rows
			.map((r) => ({ identityPublicId: r.publicId, address: r.value.trim().toLowerCase(), displayName: r.displayName ?? null }))
			.filter((r) => (on || boxes.includes(r.address)) && !seen.has(r.address) && seen.add(r.address));
	} catch (err) {
		console.error("[outlook-calendar] boites", err);
		return [];
	}
}

/**
 * Agendas affichables : ceux de la boite (Calendrier, autres agendas crees dans Outlook) et
 * ceux des collegues partages avec elle, plus les collegues ajoutes dans courrier (`extra`)
 * s'ils partagent leur agenda.
 */
export async function outlookSources(input: {
	identityPublicId: string;
	extra?: string[];
	/** false : seulement les agendas de la boite (rapide) ; les collegues viennent a part. */
	colleagues?: boolean;
	/** true : seulement les collegues. */
	colleaguesOnly?: boolean;
}): Promise<Result<{ mailbox: string; sources: CalendarSource[] }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const cfg = demo.on() ? null : graphConfig();
		// Agendas de la boite et agendas partages : lus en meme temps.
		const [own, sharedList] = await Promise.all([
			input.colleaguesOnly ? Promise.resolve([]) : demo.on() ? Promise.resolve(demo.calendars()) : listCalendars(cfg as GraphConfig, me),
			input.colleagues === false ? Promise.resolve([]) : demo.on() ? Promise.resolve(demo.shared()) : sharedCalendarOwners(cfg as GraphConfig, me),
		]);
		const sources: CalendarSource[] = own.map((c) => ({
			kind: "own" as const,
			calendarId: c.id,
			key: `own:${c.id}`,
			name: c.name,
			color: c.color,
			role: "delegateWithPrivateEventAccess" as const,
			roleLabel: c.isDefault ? "Mon agenda" : "Agenda",
			editable: c.canEdit,
			isDefault: c.isDefault,
		}));
		if (input.colleagues === false) return { ok: true, mailbox: me, sources };
		const shared = sharedList;
		const extra = (Array.isArray(input.extra) ? input.extra : [])
			.map((a) => String(a).trim().toLowerCase())
			.filter((a) => EMAIL_RE.test(a) && a !== me && !shared.some((s) => s.address === a))
			.slice(0, 30)
			.map((address) => ({ address, name: address }));
		// Droits de chaque collegue lus en parallele (2 s chacun sur Graph).
		const all = [...shared, ...extra];
		const roleList = await Promise.all(all.map((c) => roleFor(cfg, c.address, me).catch(() => "none" as CalendarRole)));
		let i = 0;
		for (const [n, c] of all.entries()) {
			const role = roleList[n];
			if (role === "none") continue;
			sources.push({
				kind: "colleague",
				owner: c.address,
				key: `colleague:${c.address}`,
				name: c.name,
				color: COLLEAGUE_COLORS[i++ % COLLEAGUE_COLORS.length],
				role,
				roleLabel: ROLE_LABEL[role],
				editable: canEditRole(role),
			});
		}
		return { ok: true, mailbox: me, sources };
	} catch (err) {
		return failure("agendas", err);
	}
}

/** Ajoute l'agenda d'un collegue s'il le partage avec l'utilisateur. */
export async function checkColleagueCalendar(input: { identityPublicId: string; address: string }): Promise<Result<{ source: CalendarSource }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const owner = String(input.address ?? "").trim().toLowerCase();
		if (!EMAIL_RE.test(owner)) throw new AgendaError("Adresse invalide.");
		if (owner === me) throw new AgendaError("C'est votre propre agenda.");
		roles.delete(`${me}>${owner}`);
		const role = await resolve(me, { kind: "colleague", owner }).then((r) => r.role);
		return {
			ok: true,
			source: { kind: "colleague", owner, key: `colleague:${owner}`, name: owner, color: COLLEAGUE_COLORS[0], role, roleLabel: ROLE_LABEL[role], editable: canEditRole(role) },
		};
	} catch (err) {
		return failure("collegue", err);
	}
}

/**
 * Evenements du `from` inclus au `to` exclu (YYYY-MM-DD, heure de Paris), pour les sources
 * demandees (aucune : l'agenda par defaut de la boite). Une source en erreur n'empeche pas
 * les autres.
 */
export async function fetchOutlookEvents(input: { identityPublicId: string; from: string; to: string; sources?: SourceRef[]; tz?: string }): Promise<OutlookEventsResult> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const tz = safeTimeZone(input.tz);
		checkRange(String(input.from), String(input.to));
		const refs: SourceRef[] = Array.isArray(input.sources) && input.sources.length ? input.sources.slice(0, 20) : [{ kind: "own" }];
		const errors: string[] = [];
		const lists = await Promise.all(
			refs.map(async (ref) => {
				try {
					const r = await resolve(me, ref);
					const key = keyOf(ref);
					const raw = demo.on()
						? demo.events(key, r.mailbox, String(input.from), String(input.to), tz)
						: await listCalendarEvents(r.cfg as GraphConfig, r.mailbox, r.calendarId, String(input.from), String(input.to), tz);
					const editable = canEditRole(r.role);
					return raw.map((e) => {
						const ev = ref.kind === "colleague" ? redactForRole(e, r.role) : e;
						// Invitation recue : l'horaire appartient a l'organisateur (comme dans Outlook).
						return { ...ev, sourceKey: key, editable: editable && (ref.kind === "colleague" || e.isOrganizer !== false) };
					});
				} catch (err) {
					errors.push(err instanceof AgendaError ? err.message : "Agenda illisible, voir le journal du serveur.");
					if (!(err instanceof AgendaError)) console.error("[outlook-calendar] lecture", err);
					return [];
				}
			}),
		);
		return { ok: true, mailbox: me, events: lists.flat(), errors: errors.length ? errors : undefined };
	} catch (err) {
		return failure("lecture", err);
	}
}

/** Detail d'un evenement (participants, corps, Teams, recurrence). */
export async function getOutlookEvent(input: { identityPublicId: string; source: SourceRef; id: string; tz?: string }): Promise<Result<{ event: EventDetail; editable: boolean; canRespond: boolean }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const r = await resolve(me, input.source);
		const tz = safeTimeZone(input.tz);
		if (input.source.kind === "colleague" && !canSeeDetails(r.role)) {
			throw new AgendaError("Ce collègue ne partage que ses disponibilités : le détail n'est pas visible.");
		}
		const event = demo.on() ? demo.get(keyOf(input.source), String(input.id), tz) : await getEvent(r.cfg as GraphConfig, r.mailbox, String(input.id), r.calendarId, tz);
		if (input.source.kind === "colleague" && event.isPrivate && !canSeePrivate(r.role)) {
			throw new AgendaError("Rendez-vous privé : le détail n'est pas visible.");
		}
		const editable = canEditRole(r.role);
		return { ok: true, event: { ...event, sourceKey: keyOf(input.source) }, editable, canRespond: input.source.kind === "own" && !event.isOrganizer };
	} catch (err) {
		return failure("detail", err);
	}
}

/** Cree (sans id) ou modifie un evenement ; invitations et mises a jour envoyees par Microsoft. */
export async function saveOutlookEvent(input: {
	identityPublicId: string;
	source: SourceRef;
	id?: string;
	event: unknown;
	scope?: EventScope;
	seriesMasterId?: string;
	/** Fichiers a joindre (base64) et pieces jointes a retirer. */
	attachments?: NewAttachment[];
	removeAttachmentIds?: string[];
}): Promise<Result<{ id?: string }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const r = await resolve(me, input.source);
		if (!canEditRole(r.role)) throw new AgendaError("Vous ne pouvez pas modifier cet agenda.");
		const n = normalizeEventInput(input.event);
		if ("error" in n) throw new AgendaError(n.error);
		const ev = { ...n.input, calendarId: r.calendarId };
		const scope: EventScope = input.scope === "series" ? "series" : "occurrence";
		const files = checkFiles(input.attachments);
		const removed = (Array.isArray(input.removeAttachmentIds) ? input.removeAttachmentIds : []).map(String).slice(0, 50);
		const key = keyOf(input.source);
		if (demo.on()) {
			const id = input.id ? demo.update(key, String(input.id), ev, scope) : demo.create(key, me, ev);
			for (const a of removed) demo.attachments.remove(id, a);
			for (const f of files) demo.attachments.add(id, f);
			return { ok: true, id };
		}
		if (input.id) {
			// Pieces jointes d'abord : la mise a jour envoyee aux participants les porte.
			const target = scope === "series" && input.seriesMasterId ? String(input.seriesMasterId) : String(input.id);
			for (const a of removed) await removeAttachment(r.cfg as GraphConfig, r.mailbox, target, a);
			for (const f of files) await addAttachment(r.cfg as GraphConfig, r.mailbox, target, f);
			await updateEvent(r.cfg as GraphConfig, r.mailbox, String(input.id), ev, scope, input.seriesMasterId ? String(input.seriesMasterId) : undefined);
			return { ok: true, id: String(input.id) };
		}
		const created = await createEvent(r.cfg as GraphConfig, r.mailbox, ev, files);
		return { ok: true, id: created.id };
	} catch (err) {
		return failure("enregistrement", err);
	}
}

/** Deplace un evenement (glisser-deposer, redimensionnement). */
export async function moveOutlookEvent(input: { identityPublicId: string; source: SourceRef; id: string; allDay: boolean; start: string; end: string; tz?: string }): Promise<Result> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const r = await resolve(me, input.source);
		if (!canEditRole(r.role)) throw new AgendaError("Vous ne pouvez pas modifier cet agenda.");
		const allDay = input.allDay === true;
		const re = allDay ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
		if (!re.test(String(input.start)) || !re.test(String(input.end)) || (allDay ? input.end < input.start : input.end <= input.start)) {
			throw new AgendaError("Nouvel horaire invalide.");
		}
		const tz = safeTimeZone(input.tz);
		if (demo.on()) demo.move(keyOf(input.source), String(input.id), allDay, input.start, input.end, tz);
		else await moveEvent(r.cfg as GraphConfig, r.mailbox, String(input.id), allDay, String(input.start), String(input.end), tz);
		return { ok: true };
	} catch (err) {
		return failure("deplacement", err);
	}
}

/** Supprime ; reunion organisee avec participants = annulation ; invitation recue = refus puis retrait. */
export async function deleteOutlookEvent(input: { identityPublicId: string; source: SourceRef; id: string; comment?: string; scope?: EventScope }): Promise<Result> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const r = await resolve(me, input.source);
		if (!canEditRole(r.role)) throw new AgendaError("Vous ne pouvez pas modifier cet agenda.");
		// Organisateur et participants relus sur Graph : le navigateur ne decide pas de l'annulation.
		if (demo.on()) {
			demo.remove(keyOf(input.source), String(input.id));
			return { ok: true };
		}
		const ev = await getEvent(r.cfg as GraphConfig, r.mailbox, String(input.id));
		// « Toute la serie » : suppression (ou annulation) de la serie entiere.
		const target = input.scope === "series" && ev.seriesMasterId ? ev.seriesMasterId : String(input.id);
		await deleteEvent(r.cfg as GraphConfig, r.mailbox, target, {
			isOrganizer: ev.isOrganizer,
			hasAttendees: ev.attendees.some((a) => a.address !== r.mailbox),
			comment: input.comment,
		});
		return { ok: true };
	} catch (err) {
		return failure("suppression", err);
	}
}

/** Repond a une invitation recue dans son propre agenda. */
export async function respondOutlookEvent(input: {
	identityPublicId: string;
	id: string;
	response: InviteResponse;
	comment?: string;
	/** Autre horaire propose (provisoire ou refus). */
	proposed?: { start: string; end: string };
	tz?: string;
}): Promise<Result> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const proposed = input.proposed ? { start: String(input.proposed.start), end: String(input.proposed.end) } : undefined;
		if (demo.on()) {
			if (proposed && input.response === "accept") throw new AgendaError("Un autre horaire se propose avec « Provisoire » ou « Refuser ».");
			demo.respond(String(input.id), input.response);
			return { ok: true };
		}
		await respondToEvent(graphConfig(), me, String(input.id), input.response, input.comment, proposed, safeTimeZone(input.tz));
		return { ok: true };
	} catch (err) {
		return failure("reponse", err);
	}
}

/** Cree un evenement simple (ancien formulaire ; garde pour la creation depuis un fil). */
export async function createOutlookEvent(input: { identityPublicId: string; event: AgendaEvent }): Promise<Result<{ mailbox: string; webLink?: string }>> {
	try {
		const address = await boxAddress(input.identityPublicId);
		const n = normalizeAgendaEvent(input.event);
		if ("error" in n) throw new AgendaError(n.error);
		if (demo.on()) {
			demo.createSimple(address, n.event);
			return { ok: true, mailbox: address };
		}
		const created = await createGraphEvent(graphConfig(), address, graphEventBody(n.event));
		return { ok: true, mailbox: address, webLink: created.webLink };
	} catch (err) {
		return failure("creation", err);
	}
}

// ---------------------------------------------------------------------------
// Pieces jointes, transfert, categories, salles, disponibilites, rappels, Teams
// ---------------------------------------------------------------------------

function checkFiles(raw: unknown): NewAttachment[] {
	const list = Array.isArray(raw) ? raw.slice(0, 20) : [];
	let total = 0;
	return list.map((f: any) => {
		const name = String(f?.name ?? "").trim().slice(0, 255) || "piece-jointe";
		const base64 = String(f?.base64 ?? "");
		if (!/^[A-Za-z0-9+/=]*$/.test(base64)) throw new AgendaError(`Fichier illisible : ${name}.`);
		const size = Math.floor((base64.length * 3) / 4);
		if (size > ATTACHMENT_MAX_BYTES) throw new AgendaError(`${name} dépasse 25 Mo.`);
		total += size;
		if (total > 35 * 1024 * 1024) throw new AgendaError("Pièces jointes trop lourdes (35 Mo au plus par enregistrement).");
		return { name, contentType: String(f?.contentType ?? "application/octet-stream").slice(0, 255), base64 };
	});
}

/** Contenu d'une piece jointe pour le telechargement. */
export async function outlookAttachment(input: { identityPublicId: string; source: SourceRef; eventId: string; attachmentId: string }): Promise<Result<{ file: NewAttachment }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const r = await resolve(me, input.source);
		if (input.source.kind === "colleague" && !canSeeDetails(r.role)) throw new AgendaError("Pièce jointe non visible avec ce partage.");
		const file = demo.on()
			? demo.attachments.get(String(input.eventId), String(input.attachmentId))
			: await getAttachment(r.cfg as GraphConfig, r.mailbox, String(input.eventId), String(input.attachmentId));
		return { ok: true, file };
	} catch (err) {
		return failure("piece jointe", err);
	}
}

/** Transfere une invitation de son agenda a d'autres personnes. */
export async function forwardOutlookEvent(input: { identityPublicId: string; id: string; to: string[]; comment?: string }): Promise<Result> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const to = (Array.isArray(input.to) ? input.to : []).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
		if (!to.length) throw new AgendaError("Indiquez au moins un destinataire.");
		if (to.some((a) => !EMAIL_RE.test(a))) throw new AgendaError("Adresse de destinataire invalide.");
		if (!demo.on()) await forwardEvent(graphConfig(), me, String(input.id), to, input.comment);
		return { ok: true };
	} catch (err) {
		return failure("transfert", err);
	}
}

/** Categories Outlook de la boite. */
export async function outlookCategories(input: { identityPublicId: string }): Promise<Result<{ categories: OutlookCategory[] }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const categories = demo.on() ? demo.categories() : await listCategories(graphConfig(), me);
		return { ok: true, categories };
	} catch (err) {
		return failure("categories", err);
	}
}

export async function createOutlookCategory(input: { identityPublicId: string; name: string; preset?: string }): Promise<Result<{ category: OutlookCategory }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const name = String(input.name ?? "").trim().slice(0, 255);
		if (!name) throw new AgendaError("Nom de catégorie vide.");
		const category = demo.on() ? demo.createCategory(name, input.preset) : await createCategory(graphConfig(), me, name, input.preset);
		return { ok: true, category };
	} catch (err) {
		return failure("categorie", err);
	}
}

// Salles du tenant, relues au plus toutes les 10 minutes.
let roomCache: { at: number; rooms: Room[] } | null = null;

export async function outlookRooms(input: { identityPublicId: string }): Promise<Result<{ rooms: Room[] }>> {
	try {
		await boxAddress(input.identityPublicId);
		if (demo.on()) return { ok: true, rooms: demo.rooms() };
		if (!roomCache || Date.now() - roomCache.at > 10 * 60_000) roomCache = { at: Date.now(), rooms: await listRooms(graphConfig()) };
		return { ok: true, rooms: roomCache.rooms };
	} catch (err) {
		return failure("salles", err);
	}
}

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Disponibilites (occupe / libre seulement) de personnes et de salles, pour l'assistant de
 * planification : la boite elle-meme, les participants, la salle.
 */
export async function outlookSchedule(input: { identityPublicId: string; addresses: string[]; from: string; to: string; tz?: string }): Promise<Result<{ schedules: Schedule[] }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const tz = safeTimeZone(input.tz);
		const from = String(input.from);
		const to = String(input.to);
		if (!DATETIME_RE.test(from) || !DATETIME_RE.test(to) || to <= from) throw new AgendaError("Période invalide.");
		if (Date.parse(`${to}:00Z`) - Date.parse(`${from}:00Z`) > 31 * 86_400_000) throw new AgendaError("Période trop longue (31 jours au plus).");
		const addresses = [me, ...(Array.isArray(input.addresses) ? input.addresses : [])]
			.map((a) => String(a).trim().toLowerCase())
			.filter((a, i, all) => EMAIL_RE.test(a) && all.indexOf(a) === i)
			.slice(0, 40);
		const schedules = demo.on() ? demo.schedules(me, addresses, from, to, tz) : await getSchedules(graphConfig(), me, addresses, from, to, tz);
		return { ok: true, schedules };
	} catch (err) {
		return failure("disponibilites", err);
	}
}

/**
 * Rappels a afficher maintenant (ou dans les 5 minutes) : ceux qu'Outlook tient pour la boite
 * (fermes ou repousses dans Outlook compris). Sans reminderView, calcules a partir des
 * evenements de l'agenda par defaut.
 */
export async function outlookDueReminders(input: { identityPublicId: string; tz?: string }): Promise<Result<{ reminders: DueReminder[]; now: string }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		const tz = safeTimeZone(input.tz);
		const now = utcToZoned(Date.now(), tz);
		const today = now.slice(0, 10);
		// Rappels des 5 prochaines minutes aussi : le navigateur les montre a l'heure dite.
		const soon = utcToZoned(Date.now() + 5 * 60_000, tz);
		const from = `${addDays(today, -1)}T00:00`;
		const to = `${addDays(today, 8)}T00:00`;
		let list: DueReminder[];
		if (demo.on()) list = demo.reminders(me, from, to, tz);
		else {
			const cfg = graphConfig();
			list = await listReminders(cfg, me, from, to, tz).catch(async () => {
				const evs = await listCalendarEvents(cfg, me, undefined, from.slice(0, 10), to.slice(0, 10), tz);
				return evs
					.filter((e) => !e.allDay && typeof e.reminderMinutes === "number")
					.map((e) => {
						const fire = new Date(Date.parse(`${e.start}:00Z`) - (e.reminderMinutes as number) * 60_000).toISOString().slice(0, 16);
						return { eventId: e.id, title: e.title, start: e.start, end: e.end, location: e.location, webLink: e.webLink, joinUrl: e.joinUrl, fireAt: fire };
					});
			});
		}
		const due = list.filter((r) => r.fireAt <= soon && r.end > now).slice(0, 10);
		if (!demo.on()) {
			const cfg = graphConfig();
			for (const r of due) if (!r.joinUrl) r.joinUrl = await eventJoinUrl(cfg, me, r.eventId);
		}
		return { ok: true, reminders: due, now };
	} catch (err) {
		return failure("rappels", err);
	}
}

export async function dismissOutlookReminder(input: { identityPublicId: string; id: string }): Promise<Result> {
	try {
		const me = await boxAddress(input.identityPublicId);
		if (demo.on()) demo.dismissReminder(String(input.id));
		else await dismissReminder(graphConfig(), me, String(input.id));
		return { ok: true };
	} catch (err) {
		return failure("rappel", err);
	}
}

export async function snoozeOutlookReminder(input: { identityPublicId: string; id: string; at: string; tz?: string }): Promise<Result> {
	try {
		const me = await boxAddress(input.identityPublicId);
		if (!DATETIME_RE.test(String(input.at))) throw new AgendaError("Heure de rappel invalide.");
		if (demo.on()) demo.snoozeReminder(String(input.id), String(input.at));
		else await snoozeReminder(graphConfig(), me, String(input.id), String(input.at), safeTimeZone(input.tz));
		return { ok: true };
	} catch (err) {
		return failure("rappel", err);
	}
}

/** Options de la reunion Teams d'un evenement que l'on organise (lien relu sur Graph). */
export async function outlookTeamsOptions(input: { identityPublicId: string; id: string }): Promise<Result<{ options: TeamsOptions }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		if (demo.on()) return { ok: true, options: demo.teams(String(input.id)) };
		const cfg = graphConfig();
		const ev = await getEvent(cfg, me, String(input.id));
		if (!ev.isOrganizer) throw new AgendaError("Seul l'organisateur règle les options de la réunion Teams.");
		if (!ev.joinUrl) throw new AgendaError("Cet événement n'est pas une réunion Teams.");
		return { ok: true, options: await getTeamsOptions(cfg, me, ev.joinUrl) };
	} catch (err) {
		return failure("teams", err);
	}
}

export async function saveOutlookTeamsOptions(input: { identityPublicId: string; id: string; options: TeamsOptions }): Promise<Result<{ options: TeamsOptions }>> {
	try {
		const me = await boxAddress(input.identityPublicId);
		if (demo.on()) return { ok: true, options: demo.setTeams({ ...input.options, meetingId: String(input.id) }) };
		const cfg = graphConfig();
		// L'identifiant de la reunion est relu depuis l'evenement, jamais pris du navigateur.
		const ev = await getEvent(cfg, me, String(input.id));
		if (!ev.isOrganizer || !ev.joinUrl) throw new AgendaError("Seul l'organisateur règle les options de la réunion Teams.");
		const current = await getTeamsOptions(cfg, me, ev.joinUrl);
		return { ok: true, options: await updateTeamsOptions(cfg, me, { ...input.options, meetingId: current.meetingId }) };
	} catch (err) {
		return failure("teams", err);
	}
}
