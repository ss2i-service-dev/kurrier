import { z } from "zod";

/** Common helpers */
const ZPort = z.coerce.number().int().min(1).max(65535);
const ZNodeEnv = z.enum(["development", "production", "test"]);

/** Server-only (never sent to the browser) */
export const ZServerConfig = z.object({
	WEB_PORT: ZPort.default(3000),
	NODE_ENV: ZNodeEnv.default("development"),
	DATABASE_URL: z.string(
		"DATABASE_URL must be a valid Postgres connection URL",
	),
	DATABASE_RLS_URL: z.string(
		"DATABASE_RLS_URL must be a valid Postgres connection URL",
	),
	JWT_SECRET: z.string("JWT_SECRET must be present"),
	APP_SECRET_ENCRYPTION_KEY: z.string("APP_SECRET_ENCRYPTION_KEY must be present"),
	REDIS_PASSWORD: z.string("REDIS_PASSWORD must be present"),
	REDIS_HOST: z.string("REDIS_HOST must be present"),
	REDIS_PORT: z.string("REDIS_PORT must be present"),
	TYPESENSE_API_KEY: z.string("TYPESENSE_API_KEY must be present"),
	TYPESENSE_PORT: z.string("TYPESENSE_PORT must be present"),
	TYPESENSE_PROTOCOL: z.string("TYPESENSE_PROTOCOL must be present"),
	TYPESENSE_HOST: z.string("TYPESENSE_HOST must be present"),
	SEARCH_REBUILD_ON_BOOT: z.string("SEARCH_REBUILD_ON_BOOT must be present"),
	S3_REGION: z.string("S3_REGION must be present"),
	S3_BUCKET: z.string("S3_BUCKET must be present"),
	S3_ENDPOINT: z.string("S3_ENDPOINT must be present"),
	S3_ACCESS_KEY: z.string("S3_ACCESS_KEY must be present"),
	S3_SECRET_KEY: z.string("S3_SECRET_KEY must be present"),
	S3_FORCE_PATH_STYLE: z.string("S3_FORCE_PATH_STYLE must be present"),
	// ss2i : fuseau des dates d'attribution des citations (defaut Europe/Paris).
	MAIL_TIMEZONE: z.string().optional(),
	// ss2i : section « Clients » des boites pro. CRM_URL (defaut https://crm.ss2i-services.fr)
	// et CRM_LORE_TOKEN (jeton partage de l'API api/lore/*, meme valeur que Lore) ; sans
	// jeton, aucun rattachement n'est calcule. CRM_PRO_DOMAINS : domaines des identites
	// concernees (defaut ss2i-digital.fr,ss2i-services.fr) ; CRM_INTERNAL_DOMAINS :
	// adresses jamais soumises a la CRM (defaut ss2i-digital.fr,ss2i-services.fr,ss2i.ca,
	// sous-domaines compris). CRM_MATCH_TTL_DAYS : age d'un rapprochement positif avant
	// re-verification (defaut 30) ; CRM_MATCH_RETRY_DAYS : idem pour un negatif, et
	// intervalle des passes de rattrapage (defaut 7).
	CRM_URL: z.string().optional(),
	CRM_LORE_TOKEN: z.string().optional(),
	CRM_PRO_DOMAINS: z.string().optional(),
	CRM_INTERNAL_DOMAINS: z.string().optional(),
	CRM_MATCH_TTL_DAYS: z.string().optional(),
	CRM_MATCH_RETRY_DAYS: z.string().optional(),
	// ss2i : « Ajouter a l'agenda » depuis un fil (OI 10280). ANTHROPIC_API_KEY : analyse du
	// fil par un LLM (API Anthropic). GRAPH_TENANT, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET :
	// app Microsoft Graph en app-only (Calendars.ReadWrite), memes noms que graph-bridge.env.
	// BRIDGE_MAILBOXES : boites M365 dont on peut ecrire l'agenda (meme liste que la
	// passerelle graph-bridge, adresses separees par des virgules).
	ANTHROPIC_API_KEY: z.string().optional(),
	GRAPH_TENANT: z.string().optional(),
	GRAPH_CLIENT_ID: z.string().optional(),
	GRAPH_CLIENT_SECRET: z.string().optional(),
	BRIDGE_MAILBOXES: z.string().optional(),
	// ss2i : « Répondre avec Lore » depuis un fil (OI 10288). LORE_URL : racine de Lore (POST
	// ${LORE_URL}/api/v1/mail/reply-draft) ; LORE_APP_TOKEN : jeton d'application de courrier
	// chez Lore. Sans l'un des deux, la fenêtre du bouton dit ce qui manque.
	LORE_URL: z.string().optional(),
	LORE_APP_TOKEN: z.string().optional(),
	// ss2i : connexion par Cerise (OI 10297). CERISE_URL = base de Cerise
	// (https://c4.ss2i-services.fr) ; sans elle, pas de bouton et les routes répondent 404.
	// CERISE_ALLOWED_DOMAINS : domaines admis, séparés par des virgules (défaut : les trois
	// domaines SS2i, cf. @common/cerise-auth).
	CERISE_URL: z.string().optional(),
	CERISE_ALLOWED_DOMAINS: z.string().optional(),
});

/** Safe to expose to the browser */
export const ZPublicConfig = z.object({
	WEB_URL: z.string("WEB_URL must be present"),
	DOCS_URL: z.string().optional(),
	DAV_URL: z.string("DAV_URL must be present"),
	// ss2i : origine publique de l'MCP courrier et de ses endpoints OAuth (defaut WEB_URL).
	MCP_PUBLIC_ORIGIN: z.string().optional(),
	// ss2i : meme fuseau pour l'apercu de la citation dans l'editeur.
	MAIL_TIMEZONE: z.string().optional(),
	DISABLE_SIGNUP: z.string().optional().transform((val) => val === "true").default(false),
});

export type ServerConfig = z.infer<typeof ZServerConfig>;
export type PublicConfig = z.infer<typeof ZPublicConfig>;

// Use a generic env shape so this package doesn't depend on Node typings
type RawEnv = Record<string, string | undefined>;

function formatZodError(label: string, err: z.ZodError) {
	const flat = err.flatten();

	const fieldErrors = Object.entries(flat.fieldErrors)
		.map(([k, v]) => {
			// v is `unknown` to TS; make it a string[] safely
			const msgs = Array.isArray(v) ? (v as string[]) : [];
			return `  - ${k}: ${msgs.join(", ")}`;
		})
		.join("\n");

	const formErrors = (flat.formErrors ?? []).map((e) => `  - ${e}`).join("\n");

	return `[${label}] Invalid configuration\n${fieldErrors}${formErrors ? `\n${formErrors}` : ""}`;
}

export function parseServerConfig(env: RawEnv): ServerConfig {
	const res = ZServerConfig.safeParse(env);
	if (!res.success) throw new Error(formatZodError("ServerConfig", res.error));
	return res.data;
}

export function parsePublicConfig(env: RawEnv): PublicConfig {
	const res = ZPublicConfig.safeParse(env);
	if (!res.success) throw new Error(formatZodError("PublicConfig", res.error));
	return res.data;
}

/** Convenience: parse both in one call (optionally cached) */
let _cache: { server: ServerConfig; public: PublicConfig } | null = null;

export function parseEnv(env: RawEnv): {
	server: ServerConfig;
	public: PublicConfig;
} {
	return {
		server: parseServerConfig(env),
		public: parsePublicConfig(env),
	};
}

/** Return only server-side envs */
export function getServerEnv(
	env: RawEnv = process.env as unknown as RawEnv,
): ServerConfig {
	return parseServerConfig(env);
}

export function getPublicEnv(
	env: RawEnv = process.env as unknown as RawEnv,
): PublicConfig {
	return parsePublicConfig(env);
}

export function getEnv(env: RawEnv = process.env as unknown as RawEnv) {
	return (_cache ??= parseEnv(env));
}
