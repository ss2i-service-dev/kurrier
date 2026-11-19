// Agenda Outlook dans courrier (page Agenda et planification dans « Ajouter à l'agenda ») :
// dates (un vendredi, les deux semaines montrent la semaine suivante), conversion des
// événements Graph (journée entière à fin incluse), mise en colonnes des chevauchements,
// placement d'une proposition sur un créneau, lecture Graph sur des fetch simulés (fuseau,
// pages, erreurs) et câblage (entrée Agenda dans les deux interfaces, panneau dans la fenêtre).
// Aucune base, aucun réseau.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx apps/web/test/outlook-calendar.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CALENDAR_MAX_DAYS,
	dayList,
	fromGraphEvent,
	layoutDay,
	listGraphEvents,
	mondayOf,
	navigationStep,
	placeEvent,
	rangeLabel,
	rangeStart,
	slotFromOffset,
	todayInParis,
	type CalendarEvent,
} from "../../../packages/common/src/outlook-calendar";
import { AgendaError } from "../../../packages/common/src/thread-agenda";
import {
	calendarRole,
	deleteEvent,
	graphEventPayload,
	graphRecurrence,
	listCalendarEvents,
	normalizeEventInput,
	parseRecurrence,
	redactForRole,
	respondToEvent,
	updateEvent,
} from "../../../packages/common/src/outlook-graph";
import { monthGrid, stepView, viewLabel } from "../../../packages/common/src/outlook-calendar";
import { convertZone, freeSlots, safeTimeZone, shiftToDay, utcToZoned, zonedToUtc } from "../../../packages/common/src/outlook-calendar";
import {
	addAttachment,
	createEvent,
	forwardEvent,
	getSchedules,
	getTeamsOptions,
	graphZoned,
	listReminders,
	toEventDetail,
	MAILBOX_CONCURRENCY,
} from "../../../packages/common/src/outlook-graph";

/** Faux Graph : jeton, puis reponses par methode + chemin ; garde chaque appel. */
function fakeGraph(routes: Record<string, (body: any) => [number, unknown]>, tenant: string) {
	const calls: { method: string; path: string; body: any; headers: Record<string, string> }[] = [];
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		if (url.startsWith("https://login.microsoftonline.com/")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
		const u = new URL(url);
		const path = decodeURIComponent(u.pathname.replace(/^\/v1\.0\/users\/[^/]+/, ""));
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({ method, path, body, headers: (init?.headers ?? {}) as Record<string, string> });
		const route = routes[`${method} ${path}`];
		if (!route) return new Response(JSON.stringify({ error: { code: "ErrorItemNotFound" } }), { status: 404 });
		const [status, data] = route(body);
		return status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(data), { status });
	}) as typeof fetch;
	return { cfg: { tenant, clientId: "c", clientSecret: "s", fetchImpl }, calls };
}

let failures = 0;
async function test(name: string, fn: () => void | Promise<void>) {
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (err) {
		failures++;
		console.error(`FAIL ${name}\n`, err);
	}
}

const root = join(__dirname, "..", "..", "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

const ev = (id: string, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
	id,
	title: id,
	allDay: false,
	start,
	end,
	...extra,
});

(async () => {
	await test("vendredi 6/11 : 14 jours du lundi 2/11 au dimanche 15/11, la semaine suivante comprise", () => {
		assert.equal(mondayOf("2026-11-06"), "2026-11-02");
		assert.equal(mondayOf("2026-11-08"), "2026-11-02"); // dimanche
		assert.equal(mondayOf("2026-11-02"), "2026-11-02");
		const days = dayList(rangeStart("2026-11-06", 14), 14);
		assert.equal(days[0], "2026-11-02");
		assert.equal(days[13], "2026-11-15");
		assert.ok(days.includes("2026-11-13")); // vendredi d'apres
		assert.equal(rangeStart("2026-11-06", 3), "2026-11-06");
		assert.equal(navigationStep(14), 7);
		assert.equal(navigationStep(3), 3);
	});

	await test("libellés de période", () => {
		assert.equal(rangeLabel("2026-11-02", 14), "2 – 15 novembre 2026");
		assert.equal(rangeLabel("2026-11-30", 14), "30 novembre – 13 décembre 2026");
		assert.equal(rangeLabel("2026-12-28", 14), "28 déc. 2026 – 10 janv. 2027");
		assert.equal(rangeLabel("2026-11-01", 1), "dim 1er novembre 2026");
	});

	await test("date du jour à Paris, pas en UTC", () => {
		assert.equal(todayInParis(new Date("2026-11-05T23:30:00Z")), "2026-11-06");
		assert.equal(todayInParis(new Date("2026-07-05T22:30:00Z")), "2026-07-06");
	});

	await test("événement Graph : horaire, journée entière (fin incluse), annulé écarté", () => {
		const t = fromGraphEvent({
			id: "a",
			subject: "Point client",
			isAllDay: false,
			start: { dateTime: "2026-11-09T09:30:00.0000000", timeZone: "Europe/Paris" },
			end: { dateTime: "2026-11-09T10:15:00.0000000", timeZone: "Europe/Paris" },
			location: { displayName: "Teams" },
			showAs: "busy",
			organizer: { emailAddress: { name: "Samuel", address: "samuel@ss2i.ca" } },
		});
		assert.deepEqual(t, {
			id: "a",
			title: "Point client",
			allDay: false,
			start: "2026-11-09T09:30",
			end: "2026-11-09T10:15",
			location: "Teams",
			showAs: "busy",
			organizer: "Samuel",
		});
		const d = fromGraphEvent({
			id: "b",
			subject: "Congés",
			isAllDay: true,
			start: { dateTime: "2026-11-09T00:00:00.0000000" },
			end: { dateTime: "2026-11-12T00:00:00.0000000" },
		});
		assert.equal(d?.start, "2026-11-09");
		assert.equal(d?.end, "2026-11-11");
		assert.equal(fromGraphEvent({ isCancelled: true, start: { dateTime: "2026-11-09T09:00:00" }, end: { dateTime: "2026-11-09T10:00:00" } }), null);
		assert.equal(fromGraphEvent({ subject: "", start: { dateTime: "2026-11-09T09:00:00" }, end: { dateTime: "2026-11-09T10:00:00" } })?.title, "(Sans titre)");
	});

	await test("colonnes : les chevauchements se partagent la largeur, le reste garde toute la largeur", () => {
		const placed = layoutDay(
			[
				ev("a", "2026-11-09T09:00", "2026-11-09T10:00"),
				ev("b", "2026-11-09T09:30", "2026-11-09T11:00"),
				ev("c", "2026-11-09T10:00", "2026-11-09T10:30"),
				ev("d", "2026-11-09T14:00", "2026-11-09T15:00"),
				ev("autre-jour", "2026-11-10T09:00", "2026-11-10T10:00"),
				ev("jour", "2026-11-09", "2026-11-09", { allDay: true }),
			],
			"2026-11-09",
		);
		const by = Object.fromEntries(placed.map((p) => [p.event.id, p]));
		assert.deepEqual(Object.keys(by).sort(), ["a", "b", "c", "d"]);
		assert.equal(by.a.col, 0);
		assert.equal(by.b.col, 1);
		assert.equal(by.c.col, 0); // a fini a 10:00, c reprend sa colonne
		assert.equal(by.a.cols, 2);
		assert.equal(by.c.cols, 2);
		assert.equal(by.d.cols, 1);
	});

	await test("colonnes : événement sur deux jours coupé à minuit, très court gardé lisible", () => {
		const night = ev("nuit", "2026-11-09T22:00", "2026-11-10T02:00");
		assert.deepEqual(
			layoutDay([night], "2026-11-09").map((p) => [p.top, p.bottom]),
			[[22 * 60, 24 * 60]],
		);
		assert.deepEqual(
			layoutDay([night], "2026-11-10").map((p) => [p.top, p.bottom]),
			[[0, 2 * 60]],
		);
		const flash = layoutDay([ev("x", "2026-11-09T09:00", "2026-11-09T09:00")], "2026-11-09");
		assert.equal(flash[0].bottom - flash[0].top, 15);
	});

	await test("clic dans la grille : quart d'heure inférieur, borné à la journée", () => {
		assert.equal(slotFromOffset(44 * 9 + 30, 44), 9 * 60 + 30);
		assert.equal(slotFromOffset(44 * 9 + 10, 44), 9 * 60);
		assert.equal(slotFromOffset(-5, 44), 0);
		assert.equal(slotFromOffset(44 * 30, 44), 23 * 60 + 45);
	});

	await test("placement d'une proposition : durée gardée, journée entière, passage horaire <-> jour", () => {
		const timed = { allDay: false, start: "2026-11-06T14:00", end: "2026-11-06T14:45", reminders: [60, 15] };
		assert.deepEqual(placeEvent(timed, "2026-11-12", 9 * 60 + 30), {
			allDay: false,
			start: "2026-11-12T09:30",
			end: "2026-11-12T10:15",
			reminders: [60, 15],
		});
		// fin bornee a 23:59 le meme jour
		assert.equal(placeEvent(timed, "2026-11-12", 23 * 60 + 30).end, "2026-11-12T23:59");
		const allDay = { allDay: true, start: "2026-11-09", end: "2026-11-11", reminders: [9600] };
		assert.deepEqual(placeEvent(allDay, "2026-11-16", null), { allDay: true, start: "2026-11-16", end: "2026-11-18", reminders: [9600] });
		// journee entiere -> horaire : 1 h, rappels par defaut (1 h, 15 min, a l'heure) ; horaire -> journee : la veille a 8 h
		assert.deepEqual(placeEvent(allDay, "2026-11-16", 9 * 60), { allDay: false, start: "2026-11-16T09:00", end: "2026-11-16T10:00", reminders: [60, 15, 0] });
		assert.deepEqual(placeEvent(timed, "2026-11-16", null), { allDay: true, start: "2026-11-16", end: "2026-11-16", reminders: [960] });
		// saisie incomplete : 1 h par defaut
		assert.equal(placeEvent({ allDay: false, start: "2026-11-06T", end: "" }, "2026-11-09", 600).end, "2026-11-09T11:00");
	});

	await test("Graph : calendarView en heure de Paris, pages suivies, annulés écartés", async () => {
		const calls: { url: string; headers: Record<string, string> }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			if (url.startsWith("https://login.microsoftonline.com/")) {
				return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			}
			calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
			if (calls.length === 1) {
				return new Response(
					JSON.stringify({
						value: [
							{ id: "1", subject: "A", start: { dateTime: "2026-11-09T09:00:00" }, end: { dateTime: "2026-11-09T10:00:00" } },
							{ id: "2", subject: "B", isCancelled: true, start: { dateTime: "2026-11-09T09:00:00" }, end: { dateTime: "2026-11-09T10:00:00" } },
						],
						"@odata.nextLink": "https://graph.microsoft.com/v1.0/next-page",
					}),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify({ value: [{ id: "3", subject: "C", start: { dateTime: "2026-11-13T15:00:00" }, end: { dateTime: "2026-11-13T16:00:00" } }] }), {
				status: 200,
			});
		}) as typeof fetch;
		const cfg = { tenant: "t-ok", clientId: "c", clientSecret: "s", fetchImpl };
		const list = await listGraphEvents(cfg, "hugo@ss2i-digital.fr", "2026-11-02", "2026-11-16");
		assert.deepEqual(list.map((e) => e.id), ["1", "3"]);
		const first = new URL(calls[0].url);
		assert.equal(first.pathname, "/v1.0/users/hugo%40ss2i-digital.fr/calendarView");
		assert.equal(first.searchParams.get("startDateTime"), "2026-11-02T00:00:00");
		assert.equal(first.searchParams.get("endDateTime"), "2026-11-16T00:00:00");
		assert.equal(calls[0].headers.prefer, 'outlook.timezone="Europe/Paris"');
		assert.equal(calls[0].headers.authorization, "Bearer tok");
		assert.equal(calls[1].url, "https://graph.microsoft.com/v1.0/next-page");
	});

	await test("Graph : erreurs lisibles, période bornée", async () => {
		const answer = (status: number, body: unknown) =>
			(async (url: string) =>
				url.startsWith("https://login.microsoftonline.com/")
					? new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 })
					: new Response(JSON.stringify(body), { status })) as typeof fetch;
		const cfg = (status: number, body: unknown) => ({ tenant: `t-${status}`, clientId: "c", clientSecret: "s", fetchImpl: answer(status, body) });
		await assert.rejects(listGraphEvents(cfg(403, {}), "a@b.fr", "2026-11-02", "2026-11-16"), (e: any) => e instanceof AgendaError && /Calendars\.Read/.test(e.message));
		await assert.rejects(
			listGraphEvents(cfg(404, { error: { code: "ErrorInvalidUser" } }), "a@b.fr", "2026-11-02", "2026-11-16"),
			(e: any) => e instanceof AgendaError && /n'est pas une boîte du tenant/.test(e.message),
		);
		await assert.rejects(listGraphEvents(cfg(200, {}), "a@b.fr", "2026-11-16", "2026-11-02"), AgendaError);
		await assert.rejects(listGraphEvents(cfg(200, {}), "a@b.fr", "2026-11-02", "2027-03-01"), (e: any) => new RegExp(`${CALENDAR_MAX_DAYS} jours`).test(e.message));
		await assert.rejects(listGraphEvents(cfg(200, {}), "a@b.fr", "2026-11-02T00:00", "2026-11-16"), AgendaError);
	});


	await test("vue mois : semaines entières du lundi au dimanche, navigation par mois", () => {
		const g = monthGrid("2026-11-18");
		assert.equal(g[0], "2026-10-26");
		assert.equal(g[g.length - 1], "2026-12-06");
		assert.equal(g.length % 7, 0);
		assert.equal(stepView("month", "2026-11-18", 1), "2026-12-01");
		assert.equal(stepView("month", "2026-01-31", -1), "2025-12-01");
		assert.equal(stepView(14, "2026-11-06", 1), "2026-11-09");
		assert.equal(viewLabel("month", "2026-11-18"), "novembre 2026");
	});

	await test("saisie : titre, horaires, participants et rappel vérifiés", () => {
		const ok = normalizeEventInput({
			title: " Point ",
			allDay: false,
			start: "2026-11-09T09:00",
			end: "2026-11-09T09:30",
			attendees: [{ address: "Samuel@SS2I-digital.fr" }, { address: "samuel@ss2i-digital.fr" }, { address: "salle@ss2i.fr", type: "resource" }],
			reminderMinutes: 15,
			recurrence: "weekly",
		});
		assert.ok("input" in ok);
		if ("input" in ok) {
			assert.equal(ok.input.title, "Point");
			assert.deepEqual(ok.input.attendees.map((a) => [a.address, a.type]), [["samuel@ss2i-digital.fr", "required"], ["salle@ss2i.fr", "resource"]]);
		}
		assert.ok("error" in normalizeEventInput({ title: "", allDay: true, start: "2026-11-09", end: "2026-11-09" }));
		assert.ok("error" in normalizeEventInput({ title: "x", allDay: false, start: "2026-11-09T10:00", end: "2026-11-09T09:00" }));
		assert.ok("error" in normalizeEventInput({ title: "x", allDay: true, start: "2026-11-09", end: "2026-11-09", attendees: [{ address: "pas une adresse" }] }));
		assert.ok("error" in normalizeEventInput({ title: "x", allDay: true, start: "2026-11-09", end: "2026-11-09", reminderMinutes: -5 }));
	});

	await test("corps Graph : journée entière à fin exclusive, Teams, participants, répétition", () => {
		const n = normalizeEventInput({
			title: "Séminaire",
			allDay: true,
			start: "2026-11-12",
			end: "2026-11-13",
			online: true,
			attendees: [{ address: "jb@ss2i-digital.fr", type: "optional" }],
			notes: "Ligne 1\nLigne <2>",
			recurrence: "monthly",
			recurrenceUntil: "2027-06-30",
		});
		assert.ok("input" in n);
		if (!("input" in n)) return;
		const b: any = graphEventPayload(n.input);
		assert.equal(b.start.dateTime, "2026-11-12T00:00:00");
		assert.equal(b.end.dateTime, "2026-11-14T00:00:00");
		assert.equal(b.isOnlineMeeting, true);
		assert.equal(b.onlineMeetingProvider, "teamsForBusiness");
		assert.deepEqual(b.attendees, [{ emailAddress: { address: "jb@ss2i-digital.fr", name: "jb@ss2i-digital.fr" }, type: "optional" }]);
		assert.match(b.body.content, /Ligne 1<br>Ligne &lt;2&gt;/);
		assert.deepEqual(b.recurrence.pattern, { type: "absoluteMonthly", interval: 1, dayOfMonth: 12 });
		assert.equal(b.recurrence.range.endDate, "2027-06-30");
		// modification sans toucher aux notes : le corps Outlook est garde
		assert.equal((graphEventPayload(n.input, { update: true }) as any).body, undefined);
	});

	await test("répétitions : aller-retour avec Graph, règle inconnue = personnalisée", () => {
		for (const r of ["daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"] as const) {
			assert.equal(parseRecurrence(graphRecurrence(r, "2026-11-11")).recurrence, r);
		}
		assert.equal(parseRecurrence({ pattern: { type: "relativeMonthly", interval: 1, daysOfWeek: ["monday"], index: "first" } }).recurrence, "custom");
		assert.equal(parseRecurrence(null).recurrence, "none");
		assert.equal((graphRecurrence("weekly", "2026-11-11")?.pattern as any).daysOfWeek[0], "wednesday");
	});

	await test("collègues : droit explicite, sinon « Mon organisation », sinon aucun", async () => {
		const perms = (list: unknown[]) => fakeGraph({ "GET /calendar/calendarPermissions": () => [200, { value: list }] }, `perm-${Math.random()}`).cfg;
		const org = { emailAddress: { name: "My Organization" }, isInsideOrganization: true, role: "freeBusyRead" };
		assert.equal(await calendarRole(perms([org, { emailAddress: { address: "Hugo@ss2i.ca" }, role: "read" }]), "samuel@x.fr", "hugo@ss2i.ca"), "read");
		assert.equal(await calendarRole(perms([org]), "samuel@x.fr", "hugo@ss2i.ca"), "freeBusyRead");
		assert.equal(await calendarRole(perms([{ emailAddress: { name: "My Organization" }, isInsideOrganization: true, role: "none" }]), "samuel@x.fr", "hugo@ss2i.ca"), "none");
		assert.equal(await calendarRole(perms([]), "samuel@x.fr", "hugo@ss2i.ca"), "none");
	});

	await test("collègues : contenu réduit selon le droit, privé masqué", () => {
		const e: CalendarEvent = { ...ev("x", "2026-11-09T09:00", "2026-11-09T10:00"), title: "Banque", location: "Agence", showAs: "busy", webLink: "https://o", joinUrl: "https://t" };
		const fb = redactForRole(e, "freeBusyRead");
		assert.equal(fb.title, "Occupé");
		assert.equal(fb.location, undefined);
		assert.equal(fb.joinUrl, undefined);
		assert.equal(redactForRole(e, "limitedRead").title, "Banque");
		assert.equal(redactForRole(e, "limitedRead").webLink, undefined);
		const priv = { ...e, isPrivate: true };
		assert.equal(redactForRole(priv, "read").title, "Rendez-vous privé");
		assert.equal(redactForRole(priv, "read").location, undefined);
		assert.equal(redactForRole(priv, "delegateWithPrivateEventAccess").title, "Banque");
	});

	await test("Graph : agenda choisi, réponse, annulation d'une réunion, refus d'une invitation", async () => {
		const { cfg, calls } = fakeGraph(
			{
				"GET /calendars/cal 1/calendarView": () => [
					200,
					{ value: [{ id: "e1", subject: "A", start: { dateTime: "2026-11-09T09:00:00" }, end: { dateTime: "2026-11-09T10:00:00" }, isOrganizer: false, responseStatus: { response: "notResponded" }, onlineMeeting: { joinUrl: "https://teams/x" }, type: "occurrence" }] },
				],
				"POST /events/e1/accept": () => [202, null],
				"POST /events/e2/cancel": () => [202, null],
				"POST /events/e3/decline": () => [202, null],
				"DELETE /events/e3": () => [204, null],
				"DELETE /events/e4": () => [204, null],
			},
			"ops",
		);
		const list = await listCalendarEvents(cfg, "hugo@x.fr", "cal 1", "2026-11-09", "2026-11-10");
		assert.equal(list[0].isOrganizer, false);
		assert.equal(list[0].responseStatus, "notResponded");
		assert.equal(list[0].joinUrl, "https://teams/x");
		assert.equal(list[0].recurring, true);
		await respondToEvent(cfg, "hugo@x.fr", "e1", "accept", "ok pour moi");
		assert.deepEqual(calls.at(-1)?.body, { comment: "ok pour moi", sendResponse: true });
		await deleteEvent(cfg, "hugo@x.fr", "e2", { isOrganizer: true, hasAttendees: true, comment: "reporté" });
		assert.equal(calls.at(-1)?.path, "/events/e2/cancel");
		assert.ok(!calls.some((c) => c.method === "DELETE" && c.path === "/events/e2"));
		await deleteEvent(cfg, "hugo@x.fr", "e3", { isOrganizer: false, hasAttendees: true });
		assert.deepEqual(calls.slice(-2).map((c) => `${c.method} ${c.path}`), ["POST /events/e3/decline", "DELETE /events/e3"]);
		await deleteEvent(cfg, "hugo@x.fr", "e4", { isOrganizer: true, hasAttendees: false });
		assert.equal(`${calls.at(-1)?.method} ${calls.at(-1)?.path}`, "DELETE /events/e4");
		await assert.rejects(respondToEvent(cfg, "hugo@x.fr", "e1", "nimporte" as any), AgendaError);
	});

	await test("Graph : toute la série garde son premier jour, une occurrence n'a jamais de répétition", async () => {
		const { cfg, calls } = fakeGraph(
			{
				"GET /events/master": () => [200, { start: { dateTime: "2026-09-07T09:30:00" }, end: { dateTime: "2026-09-07T10:00:00" } }],
				"PATCH /events/master": () => [200, {}],
				"PATCH /events/occ": () => [200, {}],
			},
			"series",
		);
		const n = normalizeEventInput({ title: "Point", allDay: false, start: "2026-11-09T10:00", end: "2026-11-09T10:45", recurrence: "weekly" });
		assert.ok("input" in n);
		if (!("input" in n)) return;
		await updateEvent(cfg, "hugo@x.fr", "occ", n.input, "series", "master");
		const patch = calls.find((c) => c.method === "PATCH")!;
		assert.equal(patch.path, "/events/master");
		assert.equal(patch.body.start.dateTime, "2026-09-07T10:00:00");
		assert.equal(patch.body.end.dateTime, "2026-09-07T10:45:00");
		assert.equal(patch.body.recurrence.range.startDate, "2026-09-07");
		await updateEvent(cfg, "hugo@x.fr", "occ", n.input, "occurrence", "master");
		const occ = calls.at(-1)!;
		assert.equal(occ.path, "/events/occ");
		assert.equal(occ.body.recurrence, undefined);
		assert.equal(occ.body.start.dateTime, "2026-11-09T10:00:00");
	});


	await test("vue mois : un evenement glisse sur un autre jour garde ses heures et sa duree", () => {
		assert.deepEqual(shiftToDay({ allDay: false, start: "2026-11-05T09:30", end: "2026-11-05T10:15" }, "2026-11-12"), {
			allDay: false,
			start: "2026-11-12T09:30",
			end: "2026-11-12T10:15",
		});
		// sur deux jours (23 h - 1 h) et en journee entiere de trois jours
		assert.deepEqual(shiftToDay({ allDay: false, start: "2026-11-05T23:00", end: "2026-11-06T01:00" }, "2026-11-30"), {
			allDay: false,
			start: "2026-11-30T23:00",
			end: "2026-12-01T01:00",
		});
		assert.deepEqual(shiftToDay({ allDay: true, start: "2026-11-05", end: "2026-11-07" }, "2026-11-02"), { allDay: true, start: "2026-11-02", end: "2026-11-04" });
	});

	await test("fuseaux : conversions avec changement d'heure, fuseau inconnu ramene a Paris", () => {
		// 5 nov. : Paris UTC+1, Montreal UTC-5
		assert.equal(convertZone("2026-11-05T15:00", "Europe/Paris", "America/Toronto"), "2026-11-05T09:00");
		assert.equal(convertZone("2026-11-05T09:00", "America/Toronto", "Europe/Paris"), "2026-11-05T15:00");
		// ete : Paris UTC+2
		assert.equal(utcToZoned(Date.UTC(2026, 6, 1, 10, 0), "Europe/Paris"), "2026-07-01T12:00");
		assert.equal(zonedToUtc("2026-07-01T12:00", "Europe/Paris"), Date.UTC(2026, 6, 1, 10, 0));
		// nuit du passage a l'heure d'hiver (25/10/2026, 3 h -> 2 h)
		assert.equal(convertZone("2026-10-25T12:00", "UTC", "Europe/Paris"), "2026-10-25T13:00");
		assert.equal(safeTimeZone("Pas/Un_Fuseau"), "Europe/Paris");
		assert.equal(safeTimeZone("x'); drop"), "Europe/Paris");
		assert.equal(safeTimeZone("America/Toronto"), "America/Toronto");
		// date Graph rendue en UTC : convertie dans le fuseau d'affichage
		assert.equal(graphZoned({ dateTime: "2026-11-05T08:00:00.0000000", timeZone: "UTC" }, "Europe/Paris"), "2026-11-05T09:00");
		assert.equal(graphZoned({ dateTime: "2026-11-05T08:00:00", timeZone: "Europe/Paris" }, "Europe/Paris"), "2026-11-05T08:00");
	});

	await test("assistant de planification : creneaux libres pour tous, heures de travail, week-end saute", () => {
		const busy = [
			[{ start: "2026-11-06T08:30", end: "2026-11-06T10:00", status: "busy" }],
			[
				{ start: "2026-11-06T10:00", end: "2026-11-06T11:00", status: "tentative" },
				{ start: "2026-11-06T11:00", end: "2026-11-06T18:00", status: "free" },
			],
		];
		const slots = freeSlots(busy, ["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"], 60, { max: 3 });
		// vendredi : 8 h 30-11 h pris (provisoire compris), « libre » ne bloque pas
		assert.deepEqual(slots[0], { start: "2026-11-06T11:00", end: "2026-11-06T12:00" });
		assert.equal(slots.length, 3);
		assert.ok(slots.every((x) => !x.start.startsWith("2026-11-07") && !x.start.startsWith("2026-11-08")));
		const later = freeSlots([], ["2026-11-06", "2026-11-09"], 30, { notBefore: "2026-11-06T17:31", max: 1 });
		assert.deepEqual(later[0], { start: "2026-11-09T08:30", end: "2026-11-09T09:00" });
	});

	await test("saisie : salle, categories, fuseau, propositions d'horaire jusqu'au corps Graph", () => {
		const n = normalizeEventInput({
			title: "Copil",
			allDay: false,
			start: "2026-11-09T10:00",
			end: "2026-11-09T11:00",
			attendees: [{ address: "a@x.fr" }],
			room: { address: "Salle-Atlantique@x.fr", name: "Salle Atlantique" },
			categories: ["Client", " Client ", ""],
			timeZone: "America/Toronto",
			allowNewTimeProposals: false,
			recurrence: "weekly",
		});
		assert.ok("input" in n);
		if (!("input" in n)) return;
		assert.deepEqual(n.input.categories, ["Client"]);
		assert.equal(n.input.attendees.find((a) => a.address === "salle-atlantique@x.fr")?.type, "resource");
		const body: any = graphEventPayload(n.input);
		assert.equal(body.start.timeZone, "America/Toronto");
		assert.equal(body.recurrence.range.recurrenceTimeZone, "America/Toronto");
		assert.deepEqual(body.location, { displayName: "Salle Atlantique", locationEmailAddress: "salle-atlantique@x.fr", locationType: "conferenceRoom" });
		assert.deepEqual(body.categories, ["Client"]);
		assert.equal(body.allowNewTimeProposals, false);
		assert.ok("error" in normalizeEventInput({ title: "x", start: "2026-11-09T10:00", end: "2026-11-09T11:00", room: { address: "pas une adresse" } }));
		assert.equal((normalizeEventInput({ title: "x", start: "2026-11-09T10:00", end: "2026-11-09T11:00", timeZone: "Mars/Olympus" }) as any).input.timeZone, "Europe/Paris");
	});

	await test("detail : salle, proposition d'un participant convertie dans le fuseau, autorisation des propositions", () => {
		const d = toEventDetail(
			{
				id: "e1",
				subject: "Copil",
				start: { dateTime: "2026-11-09T10:00:00" },
				end: { dateTime: "2026-11-09T11:00:00" },
				location: { displayName: "Salle Atlantique", locationEmailAddress: "Salle-Atlantique@x.fr", locationType: "conferenceRoom" },
				allowNewTimeProposals: true,
				attendees: [
					{ emailAddress: { address: "a@x.fr" }, type: "required", status: { response: "tentativelyAccepted" }, proposedNewTime: { start: { dateTime: "2026-11-09T13:00:00", timeZone: "UTC" }, end: { dateTime: "2026-11-09T14:00:00", timeZone: "UTC" } } },
				],
			},
			undefined,
			"Europe/Paris",
		);
		assert.deepEqual(d?.room, { address: "salle-atlantique@x.fr", name: "Salle Atlantique" });
		assert.deepEqual(d?.attendees[0].proposed, { start: "2026-11-09T14:00", end: "2026-11-09T15:00" });
		assert.equal(d?.allowNewTimeProposals, true);
	});

	await test("Graph : proposer un autre horaire, transferer, fuseau dans Prefer", async () => {
		const { cfg, calls } = fakeGraph(
			{ "POST /events/e1/tentativelyAccept": () => [202, null], "POST /events/e1/forward": () => [202, null], "POST /events/e1/accept": () => [202, null] },
			"t-propose",
		);
		await respondToEvent(cfg, "hugo@x.fr", "e1", "tentativelyAccept", "plutot l'apres-midi", { start: "2026-11-09T14:00", end: "2026-11-09T15:00" }, "America/Toronto");
		const c = calls.at(-1)!;
		assert.deepEqual(c.body.proposedNewTime.start, { dateTime: "2026-11-09T14:00:00", timeZone: "America/Toronto" });
		assert.match(String(c.headers.prefer), /America\/Toronto/);
		await assert.rejects(respondToEvent(cfg, "hugo@x.fr", "e1", "accept", "", { start: "2026-11-09T14:00", end: "2026-11-09T15:00" }), AgendaError);
		await forwardEvent(cfg, "hugo@x.fr", "e1", ["B@x.fr", "b@x.fr"], "pour info");
		assert.deepEqual(calls.at(-1)!.body.ToRecipients, [{ EmailAddress: { Address: "b@x.fr", Name: "b@x.fr" } }]);
		await assert.rejects(forwardEvent(cfg, "hugo@x.fr", "e1", ["pas-une-adresse"]), AgendaError);
	});

	await test("Graph : creation avec pieces jointes, l'invitation part apres les fichiers", async () => {
		const { cfg, calls } = fakeGraph(
			{
				"POST /events": () => [201, { id: "new", subject: "Copil", start: { dateTime: "2026-11-09T10:00:00" }, end: { dateTime: "2026-11-09T11:00:00" } }],
				"POST /events/new/attachments": () => [201, { id: "a1" }],
				"PATCH /events/new": () => [200, {}],
			},
			"t-attach",
		);
		const n = normalizeEventInput({ title: "Copil", start: "2026-11-09T10:00", end: "2026-11-09T11:00", attendees: [{ address: "a@x.fr" }] });
		if (!("input" in n)) throw new Error("saisie");
		await createEvent(cfg, "hugo@x.fr", n.input, [{ name: "ordre-du-jour.pdf", contentType: "application/pdf", base64: Buffer.from("pdf").toString("base64") }]);
		const seq = calls.map((c) => `${c.method} ${c.path}`);
		assert.deepEqual(seq, ["POST /events", "POST /events/new/attachments", "PATCH /events/new"]);
		assert.deepEqual(calls[0].body.attendees, []);
		assert.equal(calls[1].body["@odata.type"], "#microsoft.graph.fileAttachment");
		assert.equal(calls[2].body.attendees[0].emailAddress.address, "a@x.fr");
	});

	await test("Graph : piece jointe de plus de 3 Mo envoyee par session, en morceaux", async () => {
		const puts: { range: string; len: number; auth?: string }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			if (url.startsWith("https://login.microsoftonline.com/")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			if (url.includes("createUploadSession")) return new Response(JSON.stringify({ uploadUrl: "https://outlook.office.com/upload/x" }), { status: 200 });
			if (url.startsWith("https://outlook.office.com/upload/")) {
				const h = init?.headers as Record<string, string>;
				puts.push({ range: h["content-range"], len: (init?.body as Buffer).length, auth: h.authorization });
				return new Response("{}", { status: 200 });
			}
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		const size = 7 * 1024 * 1024 + 5;
		await addAttachment({ tenant: "t-upload", clientId: "c", clientSecret: "s", fetchImpl }, "hugo@x.fr", "e1", {
			name: "gros.zip",
			contentType: "application/zip",
			base64: Buffer.alloc(size, 1).toString("base64"),
		});
		assert.equal(puts.length, 3);
		assert.equal(puts[0].range, `bytes 0-${3276800 - 1}/${size}`);
		assert.equal(puts.at(-1)!.range.endsWith(`-${size - 1}/${size}`), true);
		assert.ok(puts.every((p) => !p.auth));
		await assert.rejects(addAttachment({ tenant: "t-upload", clientId: "c", clientSecret: "s", fetchImpl }, "hugo@x.fr", "e1", { name: "trop.bin", contentType: "", base64: Buffer.alloc(26 * 1024 * 1024).toString("base64") }), /25 Mo/);
	});

	await test("Graph : disponibilites sans objet, rappels, options Teams retrouvees par le lien", async () => {
		const { cfg, calls } = fakeGraph(
			{
				"POST /calendar/getSchedule": () => [
					200,
					{
						value: [
							{ scheduleId: "A@x.fr", scheduleItems: [{ status: "busy", subject: "Secret", start: { dateTime: "2026-11-09T09:00:00", timeZone: "Europe/Paris" }, end: { dateTime: "2026-11-09T10:00:00", timeZone: "Europe/Paris" } }] },
							{ scheduleId: "ext@autre.fr", error: { message: "not found" } },
						],
					},
				],
				"GET /reminderView(startDateTime='2026-11-08T00:00:00',endDateTime='2026-11-16T00:00:00')": () => [
					200,
					{
						value: [
							{
								eventId: "e1",
								eventSubject: "Copil",
								eventStartTime: { dateTime: "2026-11-09T09:00:00", timeZone: "UTC" },
								eventEndTime: { dateTime: "2026-11-09T10:00:00", timeZone: "UTC" },
								reminderFireTime: { dateTime: "2026-11-09T08:45:00", timeZone: "UTC" },
							},
						],
					},
				],
				"GET /onlineMeetings": () => [200, { value: [{ id: "m1", lobbyBypassSettings: { scope: "invited" }, allowedPresenters: "organizer", allowMeetingChat: "limited" }] }],
			},
			"t-sched",
		);
		const s = await getSchedules(cfg, "hugo@x.fr", ["a@x.fr", "ext@autre.fr", "pas une adresse"], "2026-11-09T00:00", "2026-11-10T00:00");
		assert.equal(s.length, 2);
		assert.deepEqual(s[0], { address: "a@x.fr", busy: [{ start: "2026-11-09T09:00", end: "2026-11-09T10:00", status: "busy" }], error: undefined });
		assert.ok(!JSON.stringify(s).includes("Secret"));
		assert.ok(s[1].error);
		const r = await listReminders(cfg, "hugo@x.fr", "2026-11-08T00:00", "2026-11-16T00:00");
		assert.equal(r[0].fireAt, "2026-11-09T09:45");
		assert.equal(r[0].start, "2026-11-09T10:00");
		const o = await getTeamsOptions(cfg, "hugo@x.fr", "https://teams.microsoft.com/l/meetup-join/abc'def");
		assert.equal(o.lobby, "invited");
		assert.equal(o.chat, "limited");
		// apostrophe doublee dans le filtre OData
		assert.ok(calls.some((c) => c.path === "/onlineMeetings"));
		await assert.rejects(getTeamsOptions(cfg, "hugo@x.fr", "https://evil.example/x"), AgendaError);
	});

	await test("Graph : au plus 3 appels simultanes par boite (limite d'Exchange), 429 rejoue apres Retry-After", async () => {
		let active = 0;
		let peak = 0;
		let calls = 0;
		let throttled = 0;
		const fetchImpl = (async (url: string) => {
			if (url.startsWith("https://login.microsoftonline.com/")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
			const n = ++calls;
			active++;
			peak = Math.max(peak, active);
			await new Promise((r) => setTimeout(r, 15));
			active--;
			// le premier appel est refuse une fois, comme Exchange quand trop d'appels arrivent
			if (n === 1) {
				throttled++;
				return new Response(JSON.stringify({ error: { code: "ApplicationThrottled" } }), { status: 429, headers: { "retry-after": "1" } });
			}
			return new Response(JSON.stringify({ value: [] }), { status: 200 });
		}) as typeof fetch;
		const cfg = { tenant: "t-limit", clientId: "c", clientSecret: "s", fetchImpl };
		const t0 = Date.now();
		const lists = await Promise.all(Array.from({ length: 8 }, () => listCalendarEvents(cfg, "hugo@x.fr", undefined, "2026-11-02", "2026-11-16")));
		assert.equal(lists.length, 8);
		assert.ok(peak <= MAILBOX_CONCURRENCY, `pic de ${peak} appels simultanes`);
		assert.equal(throttled, 1);
		assert.equal(calls, 9, "8 lectures + 1 rejouee");
		assert.ok(Date.now() - t0 >= 1000, "attente du Retry-After");
	});

	await test("câblage : entrée Agenda dans les deux interfaces, panneau dans « Ajouter à l'agenda », action serveur sans export interne", () => {
		assert.match(src("apps/web/components/ui/dashboards/unified/default/app-sidebar.tsx"), /dashboard\/agenda/);
		assert.match(src("apps/web/components/k/mail-shell.tsx"), /\$\{base\}\/agenda/);
		assert.match(src("apps/web/app/[locale]/w/[wPublicId]/dashboard/(unified)/(agenda)/agenda/page.tsx"), /OutlookAgendaPage/);
		const modal = src("apps/web/components/mailbox/default/add-to-agenda.tsx");
		assert.match(modal, /<PlanningPanel/);
		assert.match(modal, /placeEvent\(/);
		const actions = src("apps/web/lib/actions/outlook-calendar.ts");
		assert.match(actions, /^"use server";/);
		// un fichier "use server" n'exporte que des fonctions asynchrones
		const exported = [...actions.matchAll(/^export (async function|function|const|let|class) (\w+)/gm)];
		assert.ok(exported.every((m) => m[1] === "async function"), exported.map((m) => m[0]).join(", "));
		// rappels montes pour tout courrier, assistant et options Teams dans le formulaire
		assert.match(src("apps/web/app/[locale]/w/[wPublicId]/dashboard/(unified)/layout.tsx"), /<MeetingAlerts \/>/);
		const editor = src("apps/web/components/outlook-calendar/event-editor.tsx");
		assert.match(editor, /<SchedulingAssistant/);
		assert.match(editor, /<TeamsOptionsModal/);
		assert.match(src("apps/web/components/outlook-calendar/month-grid.tsx"), /onDrop=/);
		// lectures par la route (en parallele), pas par les actions serveur qui passent une par une
		const route = src("apps/web/app/api/outlook-calendar/route.ts");
		assert.match(route, /fetchOutlookEvents\(/);
		assert.match(src("apps/web/components/outlook-calendar/use-outlook-events.ts"), /loadEvents\(/);
		assert.doesNotMatch(src("apps/web/components/outlook-calendar/use-outlook-events.ts"), /fetchOutlookEvents/);
	});

	if (failures) {
		console.error(`\n${failures} test(s) en échec`);
		process.exit(1);
	}
	console.log("\noutlook-calendar : tout est vert");
})();
