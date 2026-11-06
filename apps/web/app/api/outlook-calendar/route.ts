// ss2i : lectures de l'agenda Outlook (agendas, collegues, evenements, rappels) par une route
// plutot que par des actions serveur : Next.js execute les actions d'un meme onglet une par
// une, si bien que la grille attendait derriere la barre laterale, les rappels et les
// categories. Ici les lectures partent en parallele. Memes controles que les actions (elles
// sont appelees telles quelles) : identite lue par RLS, droits des collegues relus cote serveur.
import { NextRequest, NextResponse } from "next/server";
import { fetchOutlookEvents, outlookDueReminders, outlookSources } from "@/lib/actions/outlook-calendar";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
	const body = (await req.json().catch(() => null)) as Record<string, any> | null;
	if (!body || typeof body.identityPublicId !== "string") return NextResponse.json({ ok: false, error: "Requête invalide." }, { status: 400 });
	const identityPublicId = body.identityPublicId;
	switch (body.op) {
		case "sources":
			return NextResponse.json(
				await outlookSources({ identityPublicId, extra: body.extra, colleagues: body.colleagues, colleaguesOnly: body.colleaguesOnly }),
			);
		case "events":
			return NextResponse.json(await fetchOutlookEvents({ identityPublicId, from: body.from, to: body.to, sources: body.sources, tz: body.tz }));
		case "reminders":
			return NextResponse.json(await outlookDueReminders({ identityPublicId, tz: body.tz }));
		default:
			return NextResponse.json({ ok: false, error: "Opération inconnue." }, { status: 400 });
	}
}
