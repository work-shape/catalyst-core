import {
  CompositeAuthAdapter,
  ApiKeyAccessTokenExchange,
  DevelopmentAuthAdapter,
  HmacSessionTokenAuthAdapter,
  HmacSessionTokenIssuer,
  HmacServiceAccessTokenAuthAdapter,
  IdentityResolvingAuthAdapter,
  createStandaloneAuthRuntime,
  type AuthAdapter
} from "@vivd-catalyst/auth";
import {
  AppError,
  normalizeAllowedOrigins,
  type ApiAccessStore,
  type ClientInstanceId,
  type UserStore
} from "@vivd-catalyst/core";
import { getDevelopmentAuthUsers, type ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ClientInstanceEnv } from "./env";

export interface ClientInstanceAuth {
  allowedOrigins: string[];
  authAdapter: AuthAdapter;
  standaloneAuth?: Awaited<ReturnType<typeof createStandaloneAuthRuntime>>;
  sessionToken?: {
    issuer: HmacSessionTokenIssuer;
    serverCredential: string;
  };
  serviceAccessToken?: {
    exchange: ApiKeyAccessTokenExchange;
  };
}

export interface CreateClientInstanceAuthInput {
  config: ClientInstanceConfig;
  env: ClientInstanceEnv;
  clientInstanceId: ClientInstanceId;
  userStore: UserStore & ApiAccessStore;
  allowedOrigins?: string | string[];
}

export async function createClientInstanceAuth(
  input: CreateClientInstanceAuthInput
): Promise<ClientInstanceAuth> {
  const allowedOrigins = resolveTrustedOrigins(input);
  const adapters: AuthAdapter[] = [];
  let standaloneAuth: ClientInstanceAuth["standaloneAuth"];
  let sessionToken: ClientInstanceAuth["sessionToken"];
  let serviceAccessToken: ClientInstanceAuth["serviceAccessToken"];

  const serviceAccessTokenSecret = input.env.SERVICE_ACCESS_TOKEN_SECRET;
  if (serviceAccessTokenSecret) {
    const serviceAccessOptions = {
      secret: serviceAccessTokenSecret,
      clientInstanceId: input.clientInstanceId,
      apiAccessStore: input.userStore
    };
    adapters.push(new HmacServiceAccessTokenAuthAdapter(serviceAccessOptions));
    serviceAccessToken = {
      exchange: new ApiKeyAccessTokenExchange(serviceAccessOptions)
    };
  }

  if (input.config.auth.standalone?.enabled) {
    standaloneAuth = await createStandaloneAuthRuntimeForClientInstance({
      ...input,
      allowedOrigins
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
    allowedOrigins,
    authAdapter: new IdentityResolvingAuthAdapter(
      new CompositeAuthAdapter(adapters),
      input.userStore,
      {
        linkByVerifiedEmail: input.config.auth.identityLinking.byVerifiedEmail
      }
    ),
    standaloneAuth,
    sessionToken,
    serviceAccessToken
  };
}

export async function createStandaloneAuthRuntimeForClientInstance(input: {
  config: ClientInstanceConfig;
  env: ClientInstanceEnv;
  clientInstanceId: ClientInstanceId;
  allowedOrigins: string[];
}): Promise<NonNullable<ClientInstanceAuth["standaloneAuth"]>> {
  if (!input.config.auth.standalone?.enabled) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Standalone auth is not enabled for this client instance"
    );
  }

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

  return createStandaloneAuthRuntime({
    clientInstanceId: input.clientInstanceId,
    databaseUrl,
    secret,
    baseUrl: resolveBetterAuthUrl(input),
    trustedOrigins: input.allowedOrigins,
    seedUsers: input.config.auth.standalone.seedUsers.map((seedUser) => ({
      email: resolveSeedEmail(seedUser, input),
      displayLabel: seedUser.displayLabel,
      password: resolveSeedPassword(seedUser, input),
      roles: seedUser.roles,
      permissionRefs: seedUser.permissionRefs,
      permissions: seedUser.permissions
    }))
  });
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
  allowedOrigins?: string | string[];
}): string[] {
  const configuredOrigins = normalizeAllowedOrigins([
    ...normalizeAllowedOrigins(input.allowedOrigins),
    ...(input.env.CHAT_UI_ORIGIN === undefined ? [] : [input.env.CHAT_UI_ORIGIN]),
    ...(input.config.auth.standalone?.trustedOrigins ?? [])
  ]);

  return input.config.clientInstance.environment === "development"
    ? [...new Set(configuredOrigins.flatMap(expandDevelopmentLoopbackOrigin))]
    : configuredOrigins;
}

function expandDevelopmentLoopbackOrigin(origin: string): string[] {
  const url = new URL(origin);
  return [
    origin,
    ...getLoopbackHostAliases(url.hostname).map((hostname) => formatOrigin(url, hostname))
  ];
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
    (input.config.clientInstance.environment === "development"
      ? seedUser.developmentPassword
      : undefined);
  if (!password) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Missing password environment variable '${seedUser.passwordEnvName}' for standalone auth seed user '${seedUser.email}'`
    );
  }
  return password;
}
