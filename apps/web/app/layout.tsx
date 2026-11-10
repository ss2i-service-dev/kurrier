import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Inter, JetBrains_Mono, Plus_Jakarta_Sans } from "next/font/google";
import { interfaceMode } from "@/lib/actions/interface-pref";
import { KUiProvider } from "@/components/k/ui-context";
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
// Font of the modern interface (per-user option).
const inter = Inter({
	variable: "--font-sans",
	subsets: ["latin"],
	// no preload: the font is only used by the modern interface (the classic one keeps Plus Jakarta Sans)
	preload: false,
});
const jetbrains = JetBrains_Mono({
	variable: "--font-mono",
	subsets: ["latin"],
});

export const metadata: Metadata = {
	title: "Kurrier",
	description: "Mailbox, but nice.",
	// Favicon declared here (public/favicon.ico) rather than by app/favicon.ico: the special file
	// of app/ was always added to the icon of a section (Mail, Calendar), and Chrome could keep
	// that one. Declared in metadata, a section replaces it.
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
	// Interface chosen by the user (classic by default).
	const modern = (await interfaceMode()) === "modern";
	const { theme: mantineTheme, colorScheme } = createMantineTheme({
		theme,
		mode,
		modern: modern,
	});

	return (
		<html
			lang="en"
			data-theme={theme}
			data-ui={modern ? "k" : undefined}
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
				className={`${modern ? inter.variable : jakartaSans.variable} ${jetbrains.variable} font-sans bg-background text-foreground antialiased`}
			>
				<AppearanceProvider initialTheme={theme} initialMode={mode}>
					<ConfigProvider value={publicConfig}>
						<MantineProvider
							theme={mantineTheme}
							defaultColorScheme={colorScheme}
						>
							<KUiProvider modern={modern}>
								<ModalsProvider>{children}</ModalsProvider>
							</KUiProvider>
						</MantineProvider>
					</ConfigProvider>
				</AppearanceProvider>
				<Script src="/keyboard-shortcuts.js" strategy="afterInteractive" />
			</body>
		</html>
	);
}
