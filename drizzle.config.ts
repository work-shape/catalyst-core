import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./packages/postgres-store/migrations",
  schema: [
    "./packages/postgres-store/src/schema.ts",
    "./packages/auth/src/standalone-auth-schema.ts"
  ],
  strict: true,
  verbose: true
});
