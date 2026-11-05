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
		// Explicit subpath, like mail-client (without it Nitro resolves @common/safe-http to
		// .../index.ts/safe-http and the build fails with ENOTDIR).
		"@common/safe-http": "../../packages/common/src/safe-http.ts",
		// HTML -> text conversion, shared with the web app.
		"@common/html-text": "../../packages/common/src/html-text.ts",
	},
	externals: {
		inline: ["@db", "@schema", "@providers", "@common", "@common/mail-client", "@common/safe-http", "@common/html-text"],
	},
	routeRules: {
		"/**": {
			cors: true,
		},
	},
});
