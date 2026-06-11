import { createStandaloneAuthRuntime } from "@vivd-catalyst/auth";
import { AppError } from "@vivd-catalyst/core";
import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";
import { loadClientEnvironment, resolveConfigPath } from "./environment";

loadClientEnvironment();

const configPath = resolveConfigPath(process.env.CLIENT_CONFIG_PATH);
const config = await loadClientInstanceConfigFromFile(configPath);
const standaloneAuth = config.auth.standalone;

if (!standaloneAuth?.enabled) {
  throw new AppError("VALIDATION_FAILED", "Standalone auth is not enabled in the demo config");
}

const databaseUrl = requireEnv("DATABASE_URL");
const secret = requireEnv("BETTER_AUTH_SECRET");

const store = await PostgresPlatformStore.connect({
  databaseUrl,
  runMigrations: process.env.RUN_MIGRATIONS !== "false"
});
await store.close();

const authRuntime = await createStandaloneAuthRuntime({
  clientInstanceId: getClientInstanceId(config),
  databaseUrl,
  secret,
  baseUrl: standaloneAuth.baseUrl ?? process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:4100/api/auth",
  trustedOrigins: resolveTrustedOrigins(config),
  seedUsers: standaloneAuth.seedUsers.map((seedUser) => ({
    email: resolveSeedEmail(seedUser),
    displayLabel: seedUser.displayLabel,
    password: resolveSeedPassword(seedUser),
    roles: seedUser.roles,
    permissionRefs: seedUser.permissionRefs
  }))
});
await authRuntime.close();

console.log(`Seeded ${standaloneAuth.seedUsers.length} standalone auth user(s).`);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new AppError("VALIDATION_FAILED", `Missing required environment variable '${name}'`);
  }
  return value;
}

function resolveTrustedOrigins(config: ClientInstanceConfig): string[] {
  return [
    ...new Set([
      ...(process.env.CHAT_UI_ORIGIN ? [process.env.CHAT_UI_ORIGIN] : []),
      ...(config.auth.standalone?.trustedOrigins ?? [])
    ])
  ];
}

function resolveSeedEmail(
  seedUser: NonNullable<ClientInstanceConfig["auth"]["standalone"]>["seedUsers"][number]
): string {
  return seedUser.emailEnvName
    ? (process.env[seedUser.emailEnvName] ?? seedUser.email)
    : seedUser.email;
}

function resolveSeedPassword(seedUser: NonNullable<ClientInstanceConfig["auth"]["standalone"]>["seedUsers"][number]): string {
  const password = process.env[seedUser.passwordEnvName] ?? seedUser.developmentPassword;
  if (!password) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Missing password environment variable '${seedUser.passwordEnvName}' for standalone auth seed user '${seedUser.email}'`
    );
  }
  return password;
}
