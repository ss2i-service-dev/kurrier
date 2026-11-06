import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Inter, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { interfaceMode } from "@/lib/actions/interface-pref";
import { KUiProvider } from "@/components/k/ui-context";
import { DatesProvider } from "@mantine/dates";
import "dayjs/locale/fr";
import "./globals.css";
import { ConfigProvider } from "@/components/providers/config-provider";
import { AppearanceProvider } from "@/components/providers/appearance-provider";
import {
	MODE_COOKIE,
	RESOLVED_COOKIE,
	THEME_COOKIE,
	ThemeMode,
	ThemeModeSchema,
	ThemeName,
	ThemeNameSchema,
} from "@schema/types/themes";
import { getPublicEnv } from "@schema";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import {
	ColorSchemeScript,
	MantineProvider,
	mantineHtmlProps,
} from "@mantine/core";
import { createMantineTheme } from "@/lib/mantine-theme";
import { ModalsProvider } from "@mantine/modals";
import Script from "next/script";

const jakartaSans = Plus_Jakarta_Sans({
	variable: "--font-sans",
	subsets: ["latin"],
});
// ss2i : police de la nouvelle interface (option par utilisateur).
const inter = Inter({
	variable: "--font-sans",
	subsets: ["latin"],
	// pas de prechargement : la police ne sert qu'a Outlook (Gmail garde Plus Jakarta Sans)
	preload: false,
});
const jetbrains = JetBrains_Mono({
	variable: "--font-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: "Kurrier",
	description: "Mailbox, but nice.",
	// ss2i : favicon declare ici (public/favicon.ico) et non plus par app/favicon.ico : le
	// fichier special de app/ s'ajoutait toujours a l'icone d'une section (Courrier, Agenda),
	// et Chrome pouvait garder celui-ci. Declare en metadata, une section le remplace.
	icons: { icon: [{ url: "/favicon.ico", sizes: "any" }] },
};

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const jar = await cookies();
	const theme: ThemeName = ThemeNameSchema.catch("indigo").parse(
		jar.get(THEME_COOKIE)?.value,
	);
	const mode: ThemeMode = ThemeModeSchema.catch("system").parse(
		jar.get(MODE_COOKIE)?.value,
	);

	const resolved = jar.get(RESOLVED_COOKIE)?.value as
		| Partial<ThemeMode>
		| undefined;
	const initialDark =
		mode === "dark" ? true : mode === "light" ? false : resolved === "dark";

	const publicConfig = getPublicEnv();
	// ss2i : interface choisie par l'utilisateur (classique par defaut).
	const nouvelle = (await interfaceMode()) === "nouvelle";
	const { theme: mantineTheme, colorScheme } = createMantineTheme({
		theme,
		mode,
		ss2i: nouvelle,
	});

	return (
		<html
			lang={nouvelle ? "fr" : "en"}
			data-theme={theme}
			data-ui={nouvelle ? "ss2i" : undefined}
			className={`${initialDark ? "dark" : ""}`}
			{...mantineHtmlProps}
		>
			<head>
				<ColorSchemeScript
					defaultColorScheme={colorScheme}
					nonce="8IBTHwOdqNKAWeKl7plt8g=="
				/>
			</head>
			<body
				className={`${nouvelle ? inter.variable : jakartaSans.variable} ${jetbrains.variable} font-sans bg-background text-foreground antialiased`}
			>
				<AppearanceProvider initialTheme={theme} initialMode={mode}>
					<ConfigProvider value={publicConfig}>
						<MantineProvider
							theme={mantineTheme}
							defaultColorScheme={colorScheme}
						>
							<KUiProvider nouvelle={nouvelle}>
								{nouvelle ? (
									// ss2i : Outlook en francais, y compris les selecteurs de date Mantine.
									<DatesProvider settings={{ locale: "fr", firstDayOfWeek: 1 }}>
										<ModalsProvider>{children}</ModalsProvider>
									</DatesProvider>
								) : (
									<ModalsProvider>{children}</ModalsProvider>
								)}
							</KUiProvider>
						</MantineProvider>
					</ConfigProvider>
				</AppearanceProvider>
				<Script src="/ss2i-shortcuts.js" strategy="afterInteractive" />
			</body>
		</html>
	);
}
