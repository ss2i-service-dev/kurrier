"use client";

// Replaces Next's generic "This page couldn't load" screen, whose Reload button reloaded the
// same error in a loop. Any error not caught lower down sends the user back to the root
// (/ -> /api/auth/resume: session and workspace restored, inbox). If the root fails again
// within 30 s, we stop here with links so that we never loop.
import React from "react";

const KEY = "kurrier.recover-error.at";
const WINDOW_MS = 30_000;

export function RecoverError({ error }: { error: Error & { digest?: string } }) {
	const [stopped, setStopped] = React.useState(false);

	React.useEffect(() => {
		console.error("[kurrier] page error", error?.digest, error);
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
				{stopped ? "This page could not be displayed" : "Returning to the inbox..."}
			</h2>
			{stopped && (
				<>
					<p style={{ maxWidth: 440, fontSize: 14, opacity: 0.7, margin: 0 }}>
						The home page failed as well. Sign in again, or try again in a moment.
						{error?.digest ? ` (reference ${error.digest})` : ""}
					</p>
					<div style={{ display: "flex", gap: 8 }}>
						<a href="/en/auth/login" style={btn(true)}>
							Sign in again
						</a>
						<a href="/" style={btn(false)}>
							Home
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
