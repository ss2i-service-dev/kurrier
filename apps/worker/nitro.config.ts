import { defineNitroConfig } from "nitropack/config";

// https://nitro.build/config
export default defineNitroConfig({
	compatibilityDate: "latest",
	// preset: 'node-server',
	srcDir: "server",
	imports: false,
	alias: {
		"@db": "../../packages/db/src/index.ts",
		"@db/*": "../../packages/db/src/*",
		"@schema": "../../packages/schema/src/index.ts",
		"@schema/*": "../../packages/schema/src/*",
		"@providers": "../../packages/providers/src/index.ts",
		"@providers/*": "../../packages/providers/src/*",
		"@common": "../../packages/common/src/index.ts",
		"@common/*": "../../packages/common/src/*",
		"@common/mail-client": "../../packages/common/src/mail-client.ts",
		// ss2i : sous-chemin explicite, comme mail-client (sans lui, Nitro resout @common/safe-http
		// en .../index.ts/safe-http et le build echoue en ENOTDIR).
		"@common/safe-http": "../../packages/common/src/safe-http.ts",
		"@common/server-client-link": "../../packages/common/src/server-client-link.ts",
		// ss2i : HTML -> texte de l'MCP, partage avec « Ajouter a l'agenda » du web (OI 10280).
		"@common/html-text": "../../packages/common/src/html-text.ts",
		"@common/subject": "../../packages/common/src/subject.ts",
	},
	externals: {
		inline: ["@db", "@schema", "@providers", "@common", "@common/mail-client", "@common/safe-http", "@common/subject", "@common/server-client-link", "@common/html-text"],
	},
	routeRules: {
		"/**": {
			cors: true,
		},
	},
});
