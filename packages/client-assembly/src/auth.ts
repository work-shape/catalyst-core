import {
  CompositeAuthAdapter,
  DevelopmentAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  IdentityResolvingAuthAdapter,
  createStandaloneAuthRuntime,
  type AuthAdapter
} from "@vivd-catalyst/auth";
import { AppError, type ClientInstanceId, type UserStore } from "@vivd-catalyst/core";
import { getDevelopmentAuthUsers, type ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ClientInstanceEnv } from "./env";

export interface ClientInstanceAuth {
  authAdapter: AuthAdapter;
  standaloneAuth?: Awaited<ReturnType<typeof createStandaloneAuthRuntime>>;
  sessionToken?: {
    issuer: HmacSessionTokenIssuer;
    serverCredential: string;
  };
}

export async function createClientInstanceAuth(input: {
  config: ClientInstanceConfig;
  env: ClientInstanceEnv;
  clientInstanceId: ClientInstanceId;
  userStore: UserStore;
  corsOrigin?: string | string[];
}): Promise<ClientInstanceAuth> {
  const adapters: AuthAdapter[] = [];
  let standaloneAuth: ClientInstanceAuth["standaloneAuth"];
  let sessionToken: ClientInstanceAuth["sessionToken"];

  if (input.config.auth.standalone?.enabled) {
    const databaseUrl = input.env.DATABASE_URL;
    const secret = input.env.BETTER_AUTH_SECRET;
    if (!databaseUrl) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Standalone Better Auth requires DATABASE_URL; start Postgres or set DATABASE_URL"
      );
    }
    if (!secret || secret.length < 32) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Standalone Better Auth requires BETTER_AUTH_SECRET with at least 32 characters"
      );
    }

    standaloneAuth = await createStandaloneAuthRuntime({
      clientInstanceId: input.clientInstanceId,
      databaseUrl,
      secret,
      baseUrl: resolveBetterAuthUrl(input),
      trustedOrigins: resolveTrustedOrigins(input),
      seedUsers: input.config.auth.standalone.seedUsers.map((seedUser) => ({
        email: resolveSeedEmail(seedUser, input),
        displayLabel: seedUser.displayLabel,
        password: resolveSeedPassword(seedUser, input),
        roles: seedUser.roles,
        permissionRefs: seedUser.permissionRefs
      }))
    });
    adapters.push(standaloneAuth.authAdapter);
  }

  const tokenSecret = input.env.CHAT_SESSION_TOKEN_SECRET;
  const serverCredential = input.env.CHAT_SERVER_CREDENTIAL;
  if (tokenSecret && serverCredential && input.config.auth.sessionToken) {
    const tokenOptions = {
      secret: tokenSecret,
      clientInstanceId: input.clientInstanceId,
      issuer: input.config.auth.sessionToken.issuer,
      ttlSeconds: input.config.auth.sessionToken.ttlSeconds
    };
    adapters.push(new HmacSessionTokenAuthAdapter(tokenOptions));
    sessionToken = {
      issuer: new HmacSessionTokenIssuer(tokenOptions),
      serverCredential
    };
  }

  const development = getDevelopmentAuthUsers(input.config);
  if (development) {
    adapters.push(
      new DevelopmentAuthAdapter({
        enabled: true,
        users: development.users,
        defaultUserId: development.defaultUserId
      })
    );
  }

  if (adapters.length === 0) {
    throw new AppError("VALIDATION_FAILED", "No auth adapter is configured");
  }

  return {
    authAdapter: new IdentityResolvingAuthAdapter(new CompositeAuthAdapter(adapters), input.userStore, {
      linkByVerifiedEmail: input.config.auth.identityLinking.byVerifiedEmail
    }),
    standaloneAuth,
    sessionToken
  };
}

function resolveBetterAuthUrl(input: {
  config: ClientInstanceConfig;
  env: ClientInstanceEnv;
}): string {
  return (
    input.config.auth.standalone?.baseUrl ??
    input.env.BETTER_AUTH_URL ??
    `http://127.0.0.1:${input.env.PORT ?? "4100"}/api/auth`
  );
}

export function resolveTrustedOrigins(input: {
  config: ClientInstanceConfig;
  env: ClientInstanceEnv;
  corsOrigin?: string | string[];
}): string[] {
  const fromCors = Array.isArray(input.corsOrigin)
    ? input.corsOrigin
    : input.corsOrigin
      ? [input.corsOrigin]
      : [];
  const configuredOrigins = [
    ...fromCors,
    ...(input.env.CHAT_UI_ORIGIN ? [input.env.CHAT_UI_ORIGIN] : []),
    ...(input.config.auth.standalone?.trustedOrigins ?? [])
  ];

  const origins =
    input.config.clientInstance.environment === "development"
      ? configuredOrigins.flatMap(expandDevelopmentLoopbackOrigin)
      : configuredOrigins.map(normalizeOrigin);

  return [...new Set(origins)];
}

function expandDevelopmentLoopbackOrigin(value: string): string[] {
  const origin = normalizeOrigin(value);
  const url = parseUrl(origin);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return [origin];
  }

  const loopbackHosts = getLoopbackHostAliases(url.hostname);
  if (loopbackHosts.length === 0) {
    return [origin];
  }

  return [
    origin,
    ...loopbackHosts
      .map((hostname) => formatOrigin(url, hostname))
      .filter((candidate) => candidate !== origin)
  ];
}

function normalizeOrigin(value: string): string {
  const url = parseUrl(value);
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return value;
  }
  return url.origin;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function getLoopbackHostAliases(hostname: string): string[] {
  const normalizedHost = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(normalizedHost)) {
    return [];
  }
  return ["127.0.0.1", "localhost", "::1"];
}

function formatOrigin(url: URL, hostname: string): string {
  const formattedHost = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `${url.protocol}//${formattedHost}${url.port ? `:${url.port}` : ""}`;
}

function resolveSeedEmail(
  seedUser: NonNullable<ClientInstanceConfig["auth"]["standalone"]>["seedUsers"][number],
  input: {
    env: ClientInstanceEnv;
  }
): string {
  return seedUser.emailEnvName
    ? (input.env[seedUser.emailEnvName] ?? seedUser.email)
    : seedUser.email;
}

function resolveSeedPassword(
  seedUser: NonNullable<ClientInstanceConfig["auth"]["standalone"]>["seedUsers"][number],
  input: {
    config: ClientInstanceConfig;
    env: ClientInstanceEnv;
  }
): string {
  const password =
    input.env[seedUser.passwordEnvName] ??
    (input.config.clientInstance.environment === "development" ? seedUser.developmentPassword : undefined);
  if (!password) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Missing password environment variable '${seedUser.passwordEnvName}' for standalone auth seed user '${seedUser.email}'`
    );
  }
  return password;
}
