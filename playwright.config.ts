import { randomBytes } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

const e2eHost = process.env.E2E_HOST ?? "127.0.0.1";
const e2eApiPort = process.env.E2E_API_PORT ?? "4210";
const e2eUiPort = process.env.E2E_UI_PORT ?? "5273";
const e2ePostgresPort = process.env.E2E_POSTGRES_PORT ?? "55433";
const e2eComposeProject = process.env.E2E_COMPOSE_PROJECT ?? "agent-chat-e2e";
const e2eApiUrl = process.env.E2E_API_URL ?? `http://${e2eHost}:${e2eApiPort}`;
const e2eUiUrl = process.env.E2E_UI_URL ?? `http://${e2eHost}:${e2eUiPort}`;
const e2eConfigPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const e2eDatabaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${e2eHost}:${e2ePostgresPort}/agent_chat`;
const useExternalServers = process.env.E2E_USE_EXTERNAL_SERVERS === "1";
// The config names this key of the Secret Store. Without the runner a run makes its own, and a
// second API a spec starts inherits it from here.
const e2eSecretStoreKey = process.env.E2E_SECRET_STORE_KEY ?? randomBytes(32).toString("base64");
process.env.E2E_SECRET_STORE_KEY = e2eSecretStoreKey;

export default defineConfig({
  testDir: "./e2e",
  // Hosted shards have separate databases and one worker each. Split large files between
  // them without introducing concurrent tests inside one instance; serial groups stay whole.
  fullyParallel: process.env.E2E_FULLY_PARALLEL === "1",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: e2eUiUrl,
    trace: "retain-on-failure"
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    }
  ],
  webServer: useExternalServers
    ? undefined
    : [
        {
          command:
            `${shellEnv({ COMPOSE_PROJECT_NAME: e2eComposeProject, POSTGRES_HOST_PORT: e2ePostgresPort })} docker compose -f clients/demo/docker-compose.yml down -v --remove-orphans && ` +
            `${shellEnv({ COMPOSE_PROJECT_NAME: e2eComposeProject, POSTGRES_HOST_PORT: e2ePostgresPort })} docker compose -f clients/demo/docker-compose.yml up -d --wait postgres && ` +
            // The API never migrates when it starts, so the explicit step runs first.
            `${shellEnv({ DATABASE_URL: e2eDatabaseUrl })} node clients/demo/dist/migrate.js && ` +
            // The build of a saved Page is a job of the workspace command worker.
            `{ ${shellEnv({ CLIENT_CONFIG_PATH: e2eConfigPath, DATABASE_URL: e2eDatabaseUrl })} node clients/demo/dist/workspace-command-worker.js & ` +
            `${shellEnv(createApiServerEnv())} node clients/demo/dist/e2e-server.js; }`,
          url: `${e2eApiUrl}/health`,
          reuseExistingServer: false,
          timeout: 60_000
        },
        {
          command: `${shellEnv({
            VITE_CHAT_API_PORT: e2eApiPort,
            VITE_CHAT_API_URL: e2eApiUrl
          })} ./node_modules/.bin/vite --host ${e2eHost} --port ${e2eUiPort}`,
          url: e2eUiUrl,
          reuseExistingServer: false,
          timeout: 30_000
        }
      ]
});

function createApiServerEnv(): Record<string, string> {
  return {
    E2E_SECRET_STORE_KEY: e2eSecretStoreKey,
    HOST: e2eHost,
    PORT: e2eApiPort,
    CLIENT_CONFIG_PATH: e2eConfigPath,
    DATABASE_URL: e2eDatabaseUrl,
    CHAT_UI_ORIGIN: e2eUiUrl,
    BETTER_AUTH_URL: `${e2eApiUrl}/api/auth`,
    BETTER_AUTH_SECRET: "e2e-better-auth-secret-with-at-least-32-characters",
    E2E_SUPERADMIN_EMAIL: "e2e-superadmin@example.test",
    E2E_USER_EMAIL: "e2e-user@example.test"
  };
}

function shellEnv(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
}
