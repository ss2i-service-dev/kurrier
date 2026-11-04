"use client";

// ss2i : plus jamais l'ecran « This page couldn't load » de Next, dont le bouton Reload
// rechargeait la meme erreur en boucle (Samuel, 04/11/2026 : « le truc le plus desastreux
// de la Terre que d'etre dans une refresh loop »). Toute erreur non rattrapee plus bas
// renvoie d'elle-meme a la racine (/ -> /api/auth/resume : session et workspace reposes,
// boite de reception). Si la racine retombe en erreur dans les 30 s, on s'arrete ici avec
// des liens, pour ne jamais boucler.
import React from "react";

const KEY = "ss2i.recover-error.at";
const WINDOW_MS = 30_000;

export function RecoverError({ error }: { error: Error & { digest?: string } }) {
	const [stopped, setStopped] = React.useState(false);

	React.useEffect(() => {
		console.error("[courrier] erreur de page", error?.digest, error);
		let last = 0;
		try {
			last = Number(sessionStorage.getItem(KEY) || 0);
		} catch {}
		if (Date.now() - last < WINDOW_MS) {
			setStopped(true);
			return;
		}
		try {
			sessionStorage.setItem(KEY, String(Date.now()));
		} catch {}
		window.location.replace("/");
	}, [error]);

	return (
		<div
			style={{
				minHeight: "100vh",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 16,
				padding: 32,
				textAlign: "center",
				fontFamily: "system-ui, sans-serif",
			}}
		>
			<h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
				{stopped ? "Cette page n'a pas pu s'afficher" : "Retour à la boîte de réception…"}
			</h2>
			{stopped && (
				<>
					<p style={{ maxWidth: 440, fontSize: 14, opacity: 0.7, margin: 0 }}>
						L'accueil vient lui aussi d'échouer. Reconnecte-toi, ou réessaie dans un instant.
						{error?.digest ? ` (référence ${error.digest})` : ""}
					</p>
					<div style={{ display: "flex", gap: 8 }}>
						<a href="/en/auth/login" style={btn(true)}>
							Se reconnecter
						</a>
						<a href="/" style={btn(false)}>
							Accueil
						</a>
					</div>
				</>
			)}
		</div>
	);
}

function btn(primary: boolean): React.CSSProperties {
	return {
		padding: "8px 16px",
		borderRadius: 6,
		fontSize: 14,
		textDecoration: "none",
		border: "1px solid currentColor",
		background: primary ? "#2563eb" : "transparent",
		color: primary ? "#fff" : "inherit",
		borderColor: primary ? "#2563eb" : "currentColor",
	};
}
