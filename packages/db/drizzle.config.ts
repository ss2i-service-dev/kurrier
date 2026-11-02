import { defineConfig } from "drizzle-kit";
import { getServerEnv } from "@schema/types/config";

const { DATABASE_URL } = getServerEnv();
export default defineConfig({
	dialect: "postgresql",
	schema: ["./src/drizzle/schema.ts", "./src/drizzle/schema-clients.ts"],
	schemaFilter: ["public"],
	out: "./src/drizzle",
	dbCredentials: {
		url: String(DATABASE_URL),
	},
});
