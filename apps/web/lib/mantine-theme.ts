import {
	createTheme,
	MantineColorScheme,
	MantineColorsTuple,
	MantineThemeOverride,
} from "@mantine/core";
import type { ThemeMode, ThemeName } from "@schema";
import colors from "tailwindcss/colors";

const pick = (p: Record<string, string>): MantineColorsTuple =>
	[
		p["50"],
		p["100"],
		p["200"],
		p["300"],
		p["400"],
		p["500"],
		p["600"],
		p["700"],
		p["800"],
		p["900"],
	] as unknown as MantineColorsTuple;

const twForTheme: Record<ThemeName, keyof typeof colors> = {
	indigo: "blue",
	violet: "violet",
	teal: "green",
	brand: "neutral",
};

function paletteFor(theme: ThemeName) {
	const brandTW = colors[twForTheme[theme]] as Record<string, string>;
	const grayTW = colors.zinc as Record<string, string>;

	return {
		brand: pick(brandTW),
		gray: pick(grayTW),
		// optional: expose a couple extra Tailwind palettes to Mantine components
		red: pick(colors.red as any),
		yellow: pick(colors.amber as any),
		green: pick(colors.green as any),
		blue: pick(colors.blue as any),
		violet: pick(colors.violet as any),
		teal: pick(colors.teal as any),
	};
}

// Mantine components of the modern interface (radii, thin borders, harmonised sizes,
// colors through the --k-* tokens). Applied only when the modern interface is on.
const field = {
	input: {
		borderRadius: 8,
		borderColor: "var(--k-line-strong)",
		backgroundColor: "var(--k-surface)",
		color: "var(--k-ink)",
		fontSize: 13.5,
	},
	label: { fontSize: 13, fontWeight: 500, color: "var(--k-ink)", marginBottom: 4 },
	description: { fontSize: 12, color: "var(--k-ink-3)" },
	error: { fontSize: 12 },
};
const fieldSelect = {
	...field,
	dropdown: {
		borderRadius: 10,
		border: "1px solid var(--k-line)",
		boxShadow: "var(--k-shadow-pop)",
		backgroundColor: "var(--k-surface)",
	},
	option: { fontSize: 13.5, borderRadius: 7 },
};

const kComponents: MantineThemeOverride["components"] = {
	Modal: {
		defaultProps: {
			radius: 14,
			shadow: "xl",
			overlayProps: { backgroundOpacity: 0.28, blur: 3 },
		},
		styles: {
			content: { boxShadow: "var(--k-shadow-pop)", backgroundColor: "var(--k-surface)" },
			header: { backgroundColor: "var(--k-surface)", paddingBottom: 6 },
			title: { fontSize: 15, fontWeight: 600, color: "var(--k-ink)" },
			body: { color: "var(--k-ink)" },
		},
	},
	Menu: {
		defaultProps: { radius: 12, shadow: "md" },
		styles: {
			dropdown: {
				padding: 4,
				border: "1px solid var(--k-line)",
				boxShadow: "var(--k-shadow-pop)",
				backgroundColor: "var(--k-surface)",
			},
			item: { fontSize: 13, borderRadius: 8, padding: "6px 10px", color: "var(--k-ink)" },
			label: { fontSize: 11, color: "var(--k-ink-3)" },
			divider: { borderColor: "var(--k-line)" },
		},
	},
	Popover: {
		defaultProps: { radius: 12, shadow: "md" },
		styles: {
			dropdown: {
				border: "1px solid var(--k-line)",
				boxShadow: "var(--k-shadow-pop)",
				backgroundColor: "var(--k-surface)",
				color: "var(--k-ink)",
			},
		},
	},
	Tooltip: {
		defaultProps: { fz: "xs", radius: 7 },
		styles: { tooltip: { backgroundColor: "var(--k-ink)", color: "var(--k-surface)", fontWeight: 500 } },
	},
	Button: {
		defaultProps: { radius: 10 },
		styles: { root: { fontWeight: 500, letterSpacing: "-0.005em" } },
	},
	TextInput: { defaultProps: { radius: 8 }, styles: field },
	Textarea: { defaultProps: { radius: 8 }, styles: field },
	Select: { defaultProps: { radius: 8 }, styles: fieldSelect },
	MultiSelect: { defaultProps: { radius: 8 }, styles: fieldSelect },
	TagsInput: { defaultProps: { radius: 8 }, styles: fieldSelect },
	DateTimePicker: { defaultProps: { radius: 8 }, styles: fieldSelect },
	Switch: {
		styles: {
			label: { fontSize: 13.5, color: "var(--k-ink)", fontWeight: 500 },
			description: { fontSize: 12.5, color: "var(--k-ink-3)" },
		},
	},
	SegmentedControl: {
		defaultProps: { radius: 8 },
		styles: {
			root: { backgroundColor: "var(--k-hover)" },
			indicator: { backgroundColor: "var(--k-surface)", boxShadow: "var(--k-shadow-pane)" },
			label: { fontSize: 13, fontWeight: 500 },
		},
	},
	Checkbox: {
		defaultProps: { radius: 5 },
		styles: { label: { fontSize: 13.5, color: "var(--k-ink)" }, description: { fontSize: 12.5, color: "var(--k-ink-3)" } },
	},
	Badge: {
		defaultProps: { radius: 6 },
		styles: { root: { fontWeight: 600, letterSpacing: 0, textTransform: "none" } },
	},
	Paper: {
		defaultProps: { radius: 12 },
		styles: { root: { borderColor: "var(--k-line)", backgroundColor: "var(--k-surface)" } },
	},
	Card: {
		defaultProps: { radius: 12 },
		styles: { root: { borderColor: "var(--k-line)", backgroundColor: "var(--k-surface)" } },
	},
};

export const createMantineTheme = ({
	theme,
	mode,
	modern = false,
}: {
	theme: ThemeName;
	mode: ThemeMode;
	/** modern interface (fixed accent palette, see app/k-ui.css) */
	modern?: boolean;
}) => {
	const palettes = modern
		? {
				...paletteFor(theme),
				brand: [
					"#f2f5fe", "#e4eafc", "#c9d4f8", "#a2b4f2", "#7089e8",
					"#4d68de", "#3555d6", "#2945bd", "#243a96", "#213475",
				] as unknown as MantineColorsTuple,
			}
		: paletteFor(theme);

	// MantineThemeOverride is fine here; createTheme returns a frozen theme
	const override: MantineThemeOverride = {
		colors: palettes,
		primaryColor: "brand",
		// Modern interface in dark mode keeps a deep blue (readable white text).
		primaryShade: modern ? { light: 6, dark: 6 } : { light: 6, dark: 4 },
		// defaultRadius: 'md',
		fontFamily: "var(--font-sans, Inter, system-ui, sans-serif)",
		headings: {
			fontFamily: "var(--font-sans, Inter, system-ui, sans-serif)",
		},
		...(modern ? { components: kComponents } : {}),
	};

	return {
		theme: createTheme(override),
		colorScheme: (mode === "system" ? "auto" : mode) as MantineColorScheme,
	};
};
