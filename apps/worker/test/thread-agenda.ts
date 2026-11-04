// « Ajouter a l'agenda » depuis un fil (packages/common/src/thread-agenda.ts, OI 10280) :
// corps Graph (journee entiere : fin au lendemain 00:00, rappel choisi), minutes des rappels,
// recapitulatif en clair, validation des propositions et
// des saisies, texte du fil envoye au LLM, requete a l'API Anthropic et erreurs Graph sur
// des fetch simules. Aucune base, aucun reseau. Avec ANTHROPIC_API_KEY dans l'environnement,
// un essai reel sur le fil de reference « Stage d'observation » du 04/11/2026 en plus.
// Lancement (depuis la racine) :
//   node_modules/.bin/tsx --tsconfig apps/worker/tsconfig.json apps/worker/test/thread-agenda.ts
import assert from "node:assert/strict";
import {
	AGENDA_MODEL,
	ALL_DAY_REMINDERS,
	AgendaError,
	type AgendaMessage,
	agendaTranscript,
	agendaWhen,
	createGraphEvent,
	extractAgendaEvents,
	graphEventBody,
	normalizeAgendaEvent,
	parseAgendaEvents,
	parseMailboxList,
	reminderMinutes,
	TIMED_REMINDERS,
} from "../../../packages/common/src/thread-agenda";

let failures = 0;
const test = async (label: string, fn: () => unknown) => {
	try {
		await fn();
		console.log(`ok    ${label}`);
	} catch (err: any) {
		failures++;
		console.error(`FAIL  ${label}\n      ${String(err?.message ?? err).split("\n").join("\n      ")}`);
	}
};

const ok = (raw: unknown) => {
	const n = normalizeAgendaEvent(raw);
	if ("error" in n) throw new Error(`refuse : ${n.error}`);
	return n.event;
};

// Le fil de reference, tel que lu en base (corps texte, dates des messages).
const STAGE: AgendaMessage[] = [
	{
		from: "Christophe SAUVION <christophe.sauvion@ss2i-services.fr>",
		date: "2026-11-04T10:43:39.000Z",
		text: "Nous allons recevoir un stagiaire en dev du 7 au 11 décembre. Il s'agit d'un jeune non voyant (même histoire que Anne-Cha sauf qu'il ne voit plus).\n\nIl voudrait découvrir le métier de dev web. Il vient avec son matos. Il n'a jamais fait de dev. Est ce qu'on pourrait lui faire réaliser un mini projet ?\n\n[cid:c304132c-5f3e-4c98-b2b0-62d35579c1cd]",
	},
	{
		from: "samuel@ss2i-digital.fr",
		date: "2026-11-04T11:08:03.767Z",
		text: "On 04 Nov 2026, 11:43, Christophe SAUVION <christophe.sauvion@ss2i-services.fr> wrote:\n> Nous allons recevoir un stagiaire en dev du 7 au 11 décembre. Il s'agit d'un jeune non voyant (même histoire que Anne-Cha sauf qu'il ne voit plus).\n>\n> Il voudrait découvrir le métier de dev web. Il vient avec son matos. Il n'a jamais fait de dev. Est ce qu'on pourrait lui faire réaliser un mini projet ?\n\nOk pour le recevoir, par contre je ne sais vraiment pas calibrer une activité avec un tel handicap. \n\nOn essaiera d'improviser un truc.\n\n--",
	},
	{
		from: "Christophe SAUVION <christophe.sauvion@ss2i-services.fr>",
		date: "2026-11-04T11:08:59.000Z",
		text: "\u{1F44D}\n\n[cid:e4d6de4c-2b41-447e-8517-f5bb529e1912]\n________________________________\nDe : Samuel Legros <samuel@ss2i-digital.fr>\nEnvoyé : mercredi 4 novembre 2026 12:08\nÀ : Christophe SAUVION <christophe.sauvion@ss2i-services.fr>\nObjet : Re: Stage d'observation\n\nOn 04 Nov 2026, 11:43, Christophe SAUVION wrote:\nNous allons recevoir un stagiaire en dev du 7 au 11 décembre.\n\nOk pour le recevoir.",
	},
];

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function main() {
	// --- Corps Graph ----------------------------------------------------------------

	await test("journee entiere du 7 au 11 decembre : fin au 12 a 00:00, libre, Europe/Paris", () => {
		const e = ok({ title: "Stagiaire dev (stage d'observation)", allDay: true, start: "2026-12-07", end: "2026-12-11", location: "", notes: "", sourceQuote: "du 7 au 11 décembre" });
		const b: any = graphEventBody(e);
		assert.equal(b.subject, "Stagiaire dev (stage d'observation)");
		assert.equal(b.isAllDay, true);
		assert.deepEqual(b.start, { dateTime: "2026-12-07T00:00:00", timeZone: "Europe/Paris" });
		assert.deepEqual(b.end, { dateTime: "2026-12-12T00:00:00", timeZone: "Europe/Paris" });
		assert.equal(b.showAs, "free");
		assert.equal("location" in b, false);
		// « Aucun rappel » par defaut, jamais celui de Graph (15 min)
		assert.equal(b.isReminderOn, false);
		assert.equal("reminderMinutesBeforeStart" in b, false);
	});

	await test("rappels : minutes avant le debut (journee entiere : depuis 00:00 heure de Paris)", () => {
		assert.equal(reminderMinutes("none", true), null);
		assert.equal(reminderMinutes(undefined, true), null);
		assert.equal(reminderMinutes("day-before-8h", true), 960);
		assert.equal(reminderMinutes("2-days-8h", true), 2400);
		assert.equal(reminderMinutes("week-8h", true), 9600);
		assert.equal(reminderMinutes("none", false), null);
		assert.equal(reminderMinutes("15m", false), 15);
		assert.equal(reminderMinutes("1h", false), 60);
		assert.equal(reminderMinutes("day-before", false), 1440);
		// un choix d'horaire ne vaut pas pour une journee entiere, et inversement
		assert.equal(reminderMinutes("15m", true), undefined);
		assert.equal(reminderMinutes("week-8h", false), undefined);
		assert.deepEqual(ALL_DAY_REMINDERS.map((o) => o.label), ["Aucun rappel", "La veille à 8 h", "2 jours avant à 8 h", "Une semaine avant à 8 h"]);
		assert.deepEqual(TIMED_REMINDERS.map((o) => o.label), ["Aucun rappel", "15 minutes avant", "1 heure avant", "La veille"]);
	});

	await test("corps Graph : rappel choisi (isReminderOn + reminderMinutesBeforeStart)", () => {
		const veille: any = graphEventBody(ok({ title: "x", allDay: true, start: "2026-12-07", end: "2026-12-11", sourceQuote: "", reminder: "day-before-8h" }));
		assert.equal(veille.isReminderOn, true);
		assert.equal(veille.reminderMinutesBeforeStart, 960);
		const semaine: any = graphEventBody(ok({ title: "x", allDay: true, start: "2026-12-07", end: "", sourceQuote: "", reminder: "week-8h" }));
		assert.equal(semaine.reminderMinutesBeforeStart, 9600);
		const heure: any = graphEventBody(ok({ title: "x", allDay: false, start: "2026-12-08T14:00", end: "", sourceQuote: "", reminder: "1h" }));
		assert.equal(heure.isReminderOn, true);
		assert.equal(heure.reminderMinutesBeforeStart, 60);
		const aucun: any = graphEventBody(ok({ title: "x", allDay: false, start: "2026-12-08T14:00", end: "", sourceQuote: "", reminder: "none" }));
		assert.equal(aucun.isReminderOn, false);
		assert.equal("reminderMinutesBeforeStart" in aucun, false);
	});

	await test("validation : rappel d'un autre type refuse, rappel garde sinon", () => {
		assert.ok("error" in normalizeAgendaEvent({ title: "x", allDay: true, start: "2026-12-07", end: "", reminder: "15m" }));
		assert.ok("error" in normalizeAgendaEvent({ title: "x", allDay: false, start: "2026-12-07T10:00", end: "", reminder: "day-before-8h" }));
		assert.ok("error" in normalizeAgendaEvent({ title: "x", allDay: true, start: "2026-12-07", end: "", reminder: "n'importe" }));
		assert.equal(ok({ title: "x", allDay: true, start: "2026-12-07", end: "", sourceQuote: "" }).reminder, "none");
		assert.equal(ok({ title: "x", allDay: true, start: "2026-12-07", end: "", sourceQuote: "", reminder: "2-days-8h" }).reminder, "2-days-8h");
	});

	await test("recapitulatif : dates en clair", () => {
		const w = (raw: object) => agendaWhen(ok({ title: "x", sourceQuote: "", ...raw }));
		assert.equal(w({ allDay: true, start: "2026-12-07", end: "2026-12-11" }), "du lundi 7 au vendredi 11 décembre 2026, journée entière");
		assert.equal(w({ allDay: true, start: "2026-12-07", end: "" }), "lundi 7 décembre 2026, journée entière");
		assert.equal(w({ allDay: true, start: "2026-11-30", end: "2026-12-02" }), "du lundi 30 novembre au mercredi 2 décembre 2026, journée entière");
		assert.equal(w({ allDay: true, start: "2026-12-31", end: "2027-01-01" }), "du jeudi 31 décembre 2026 au vendredi 1er janvier 2027, journée entière");
		assert.equal(w({ allDay: false, start: "2026-12-08T14:00", end: "2026-12-08T15:30" }), "mardi 8 décembre 2026, de 14 h à 15 h 30");
		assert.equal(w({ allDay: false, start: "2026-12-01T09:00", end: "" }), "mardi 1er décembre 2026, de 9 h à 10 h");
		assert.equal(w({ allDay: false, start: "2026-12-08T22:00", end: "2026-12-09T02:00" }), "du mardi 8 décembre 2026 à 22 h au mercredi 9 décembre 2026 à 2 h");
	});

	await test("journee entiere d'un seul jour (fin vide) et passage d'annee", () => {
		const one: any = graphEventBody(ok({ title: "Échéance", allDay: true, start: "2026-12-31", end: "", sourceQuote: "" }));
		assert.equal(one.start.dateTime, "2026-12-31T00:00:00");
		assert.equal(one.end.dateTime, "2027-01-01T00:00:00");
		const feb: any = graphEventBody(ok({ title: "Bissextile", allDay: true, start: "2028-02-28", end: "2028-02-29", sourceQuote: "" }));
		assert.equal(feb.end.dateTime, "2028-03-01T00:00:00");
	});

	await test("horaire : heure de Paris sans decalage, fin par defaut une heure apres, occupe", () => {
		const e = ok({ title: "Réunion", allDay: false, start: "2026-12-08T14:00", end: "", location: "Mairie de Tours", sourceQuote: "" });
		assert.equal(e.end, "2026-12-08T15:00");
		const b: any = graphEventBody(e);
		assert.equal(b.isAllDay, false);
		assert.deepEqual(b.start, { dateTime: "2026-12-08T14:00:00", timeZone: "Europe/Paris" });
		assert.deepEqual(b.end, { dateTime: "2026-12-08T15:00:00", timeZone: "Europe/Paris" });
		assert.equal("showAs" in b, false);
		assert.deepEqual(b.location, { displayName: "Mairie de Tours" });
		const late = ok({ title: "Tard", allDay: false, start: "2026-12-31T23:30", end: "", sourceQuote: "" });
		assert.equal(late.end, "2027-01-01T00:30");
	});

	await test("corps : notes echappees puis lien vers le fil", () => {
		const e = ok({ title: "T", allDay: true, start: "2026-12-07", end: "2026-12-07", notes: "Contact <b>Paul</b> & co\n2e ligne", sourceQuote: "" });
		const b: any = graphEventBody(e, { threadUrl: "https://mail.ss2i.ca/w/W/dashboard/mail/I/inbox/threads/T?x=1&y=\"2\"", threadSubject: "Stage <d'obs>" });
		assert.equal(b.body.contentType, "HTML");
		assert.match(b.body.content, /Contact &lt;b&gt;Paul&lt;\/b&gt; &amp; co<br>2e ligne/);
		assert.match(b.body.content, /href="https:\/\/mail\.ss2i\.ca\/w\/W\/dashboard\/mail\/I\/inbox\/threads\/T\?x=1&amp;y=&quot;2&quot;"/);
		assert.match(b.body.content, /Fil « Stage &lt;d'obs&gt; » dans courrier/);
	});

	// --- Validation -----------------------------------------------------------------

	await test("validation : titre vide, date impossible, fin avant debut refuses", () => {
		assert.ok("error" in normalizeAgendaEvent({ title: " ", allDay: true, start: "2026-12-07", end: "" }));
		assert.ok("error" in normalizeAgendaEvent({ title: "x", allDay: true, start: "2026-02-30", end: "" }));
		assert.ok("error" in normalizeAgendaEvent({ title: "x", allDay: true, start: "2026-12-11", end: "2026-12-07" }));
		assert.ok("error" in normalizeAgendaEvent({ title: "x", allDay: false, start: "2026-12-07T10:00", end: "2026-12-07T09:00" }));
		assert.ok("error" in normalizeAgendaEvent({ title: "x", allDay: false, start: "2026-12-07T25:00", end: "" }));
		assert.ok("error" in normalizeAgendaEvent(null));
	});

	await test("validation : une date sans heure donne une journee entiere", () => {
		const e = ok({ title: "x", allDay: false, start: "2026-12-07", end: "", sourceQuote: "" });
		assert.equal(e.allDay, true);
		assert.equal(e.end, "2026-12-07");
		const f = ok({ title: "x", allDay: true, start: "2026-12-07T09:00", end: "2026-12-09T18:00", sourceQuote: "" });
		assert.deepEqual([f.start, f.end], ["2026-12-07", "2026-12-09"]);
	});

	await test("propositions du LLM : les invalides sont ecartees, champs vides retires", () => {
		const list = parseAgendaEvents({
			events: [
				{ title: "A", allDay: true, start: "2026-12-07", end: "2026-12-11", location: "", notes: "", sourceQuote: "q" },
				{ title: "B", allDay: true, start: "bientot", end: "", location: "", notes: "", sourceQuote: "" },
			],
		});
		assert.equal(list.length, 1);
		assert.equal(list[0].location, undefined);
		assert.equal(list[0].notes, undefined);
		assert.deepEqual(parseAgendaEvents({}), []);
		assert.deepEqual(parseAgendaEvents("x"), []);
	});

	await test("BRIDGE_MAILBOXES : liste en minuscules", () => {
		assert.deepEqual(parseMailboxList(" Samuel@SS2I-digital.fr, jb@ss2i-digital.fr;hugo@ss2i-services.fr ,, "), [
			"samuel@ss2i-digital.fr",
			"jb@ss2i-digital.fr",
			"hugo@ss2i-services.fr",
		]);
		assert.deepEqual(parseMailboxList(undefined), []);
	});

	// --- Texte du fil -----------------------------------------------------------------

	await test("texte du fil : dates en clair a Paris, citation retiree apres le 1er message", () => {
		const t = agendaTranscript({ subject: "RE: Stage d'observation", mailbox: "samuel@ss2i-digital.fr", messages: STAGE, now: new Date("2026-11-04T12:00:00Z") });
		assert.match(t, /Objet du fil : RE: Stage d'observation/);
		assert.match(t, /Agenda de : samuel@ss2i-digital\.fr/);
		assert.match(t, /Date du jour : mercredi 4 novembre 2026/);
		assert.match(t, /===== Message 1\/3 =====\nDe : Christophe SAUVION <christophe\.sauvion@ss2i-services\.fr>\nDate : mercredi 4 novembre 2026 à 11:43/);
		assert.match(t, /du 7 au 11 décembre/);
		// 2e message : reponse sous la citation, les lignes « > » partent
		const second = t.split("===== Message 2/3 =====")[1].split("===== Message 3/3 =====")[0];
		assert.match(second, /Ok pour le recevoir/);
		assert.doesNotMatch(second, /> Nous allons/);
		// 3e message : l'historique sous la ligne de soulignes est coupe
		const third = t.split("===== Message 3/3 =====")[1];
		assert.doesNotMatch(third, /Envoyé :/);
		assert.doesNotMatch(third, /stagiaire/);
	});

	await test("texte du fil : message HTML seul converti en texte", () => {
		const t = agendaTranscript({
			subject: null,
			mailbox: "a@b.fr",
			messages: [{ from: "x", date: null, html: "<p>Rendez-vous <b>mardi</b> &agrave; 10h</p><blockquote>vieux</blockquote>" }],
		});
		assert.match(t, /\(sans objet\)/);
		assert.match(t, /Date : date inconnue/);
		assert.match(t, /Rendez-vous mardi à 10h/);
	});

	// --- API Anthropic (fetch simule) ----------------------------------------------------

	await test("requete : modele, version, sortie JSON contrainte, pas de parametre d'echantillonnage", async () => {
		let seen: { url: string; init: RequestInit } | null = null;
		const fetchImpl = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return json(200, {
				stop_reason: "end_turn",
				content: [
					{ type: "thinking", thinking: "" },
					{ type: "text", text: JSON.stringify({ events: [{ title: "Stagiaire", allDay: true, start: "2026-12-07", end: "2026-12-11", location: "", notes: "", sourceQuote: "du 7 au 11 décembre" }] }) },
				],
			});
		}) as unknown as typeof fetch;
		const events = await extractAgendaEvents({ apiKey: "k", fetchImpl }, "texte");
		assert.equal(events.length, 1);
		assert.equal(events[0].end, "2026-12-11");
		assert.ok(seen);
		const s = seen as { url: string; init: RequestInit };
		assert.equal(s.url, "https://api.anthropic.com/v1/messages");
		const h = s.init.headers as Record<string, string>;
		assert.equal(h["x-api-key"], "k");
		assert.equal(h["anthropic-version"], "2026-10-21");
		const body = JSON.parse(String(s.init.body));
		assert.equal(body.model, AGENDA_MODEL);
		assert.equal(body.model, "claude-haiku-5-5");
		assert.equal(body.output_config.format.type, "json_schema");
		assert.equal(body.output_config.format.schema.properties.events.items.additionalProperties, false);
		assert.equal("temperature" in body, false);
		assert.equal("thinking" in body, false);
		assert.equal(body.messages[0].content, "texte");
	});

	await test("API : un second essai apres une surcharge, refus et cle invalide lisibles", async () => {
		let calls = 0;
		const flaky = (async () => {
			calls++;
			if (calls === 1) return json(529, { error: { type: "overloaded_error", message: "Overloaded" } }, { "retry-after": "0" });
			return json(200, { stop_reason: "end_turn", content: [{ type: "text", text: '{"events":[]}' }] });
		}) as unknown as typeof fetch;
		assert.deepEqual(await extractAgendaEvents({ apiKey: "k", fetchImpl: flaky }, "t"), []);
		assert.equal(calls, 2);

		const refusal = (async () => json(200, { stop_reason: "refusal", content: [] })) as unknown as typeof fetch;
		await assert.rejects(extractAgendaEvents({ apiKey: "k", fetchImpl: refusal }, "t"), (e: any) => e instanceof AgendaError && /refusé/.test(e.message));

		const denied = (async () => json(401, { error: { type: "authentication_error", message: "invalid x-api-key" } })) as unknown as typeof fetch;
		await assert.rejects(extractAgendaEvents({ apiKey: "k", fetchImpl: denied }, "t"), (e: any) => e instanceof AgendaError && /ANTHROPIC_API_KEY refusée \(HTTP 401\)/.test(e.message));
	});

	// --- Graph (fetch simule) -----------------------------------------------------------

	await test("Graph : jeton app-only reutilise, adresse hors tenant refusee clairement", async () => {
		const urls: string[] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			urls.push(url);
			if (url.includes("login.microsoftonline.com")) {
				assert.match(String(init.body), /grant_type=client_credentials/);
				assert.match(String(init.body), /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
				return json(200, { access_token: "tok", expires_in: 3599 });
			}
			if (url.includes("inconnu%40gmail.com")) return json(404, { error: { code: "ErrorInvalidUser", message: "The requested user is invalid." } });
			return json(201, { id: "evt1", webLink: "https://outlook.office365.com/x" });
		}) as unknown as typeof fetch;
		const cfg = { tenant: "t-test-cache", clientId: "c", clientSecret: "s", fetchImpl };
		const body = graphEventBody(ok({ title: "x", allDay: true, start: "2026-12-07", end: "", sourceQuote: "" }));
		const created = await createGraphEvent(cfg, "samuel@ss2i-digital.fr", body);
		assert.equal(created.id, "evt1");
		assert.equal(urls[1], "https://graph.microsoft.com/v1.0/users/samuel%40ss2i-digital.fr/events");
		await assert.rejects(createGraphEvent(cfg, "inconnu@gmail.com", body), (e: any) => e instanceof AgendaError && /inconnu@gmail\.com n'est pas une boîte du tenant/.test(e.message));
		assert.equal(urls.filter((u) => u.includes("login.microsoftonline.com")).length, 1);
	});

	// --- Essai reel (cle locale seulement) ------------------------------------------------

	const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
	if (!apiKey) {
		console.log("skip  essai reel du LLM : ANTHROPIC_API_KEY absente");
	} else {
		await test("LLM reel : « Stage d'observation » donne un seul evenement, journee entiere du 7 au 11 decembre 2026", async () => {
			const transcript = agendaTranscript({ subject: "RE: Stage d'observation", mailbox: "samuel@ss2i-digital.fr", messages: STAGE, now: new Date("2026-11-04T12:00:00Z") });
			const started = Date.now();
			const events = await extractAgendaEvents({ apiKey }, transcript);
			console.log(`      ${Date.now() - started} ms`, JSON.stringify(events));
			assert.equal(events.length, 1);
			assert.equal(events[0].allDay, true);
			assert.equal(events[0].start, "2026-12-07");
			assert.equal(events[0].end, "2026-12-11");
			assert.match(events[0].title, /stagiaire/i);
		});
	}

	if (failures) {
		console.error(`\n${failures} test(s) en echec`);
		process.exit(1);
	}
	console.log("\ntous les tests passent");
}

void main();
