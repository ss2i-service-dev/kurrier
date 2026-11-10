// Subject without reply and forward prefixes. Mail clients stack "RE: TR: RE: Fwd:"
// (Outlook in capitals, "TR:" in French, "AW:" and "WG:" in German, etc.). Per-user option
// (workspaces.meta.prefStripSubjectPrefixes), off by default: on, nothing is added when
// replying or forwarding and nothing is displayed; the thread holds by In-Reply-To and
// References, not by the subject. Pure functions, no dependency: imported on the browser side.

// Known prefixes, lower case: English, French, German, Nordic, Dutch, Italian, Spanish,
// Portuguese. A prefix can carry a counter ("Re[2]:", "RE(3):") and the colon can be
// full-width ("：").
const PREFIXES = [
	"re",
	"ré",
	"fw",
	"fwd",
	"tr",
	"trans",
	"aw",
	"wg",
	"sv",
	"vs",
	"vb",
	"antw",
	"doorst",
	"rif",
	"rv",
	"enc",
	"res",
];

const PREFIX_RE = new RegExp(
	`^\\s*(?:${PREFIXES.join("|")})\\s*(?:\\[\\d+\\]|\\(\\d+\\))?\\s*[:：]\\s*`,
	"iu",
);

/** Subject stripped of every leading reply and forward prefix, stacked or not. */
export function stripSubjectPrefixes(subject: string | null | undefined): string {
	let s = (subject ?? "").trim();
	for (;;) {
		const next = s.replace(PREFIX_RE, "");
		if (next === s) return s;
		s = next.trim();
	}
}

/** Subject to display: as received when the option is off, stripped when it is on. */
export function subjectForDisplay(subject: string | null | undefined, strip: boolean): string {
	return strip ? stripSubjectPrefixes(subject) : (subject ?? "");
}
