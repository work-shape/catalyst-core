import { defineConfig, devices } from "@playwright/test";

const e2eHost = process.env.E2E_HOST ?? "127.0.0.1";
const e2eApiPort = process.env.E2E_API_PORT ?? "4210";
const e2eUiPort = process.env.E2E_UI_PORT ?? "5273";
const e2ePostgresPort = process.env.E2E_POSTGRES_PORT ?? "55433";
const e2eComposeProject = process.env.E2E_COMPOSE_PROJECT ?? "agent-chat-e2e";
const e2eApiUrl = process.env.E2E_API_URL ?? `http://${e2eHost}:${e2eApiPort}`;
const e2eUiUrl = process.env.E2E_UI_URL ?? `http://${e2eHost}:${e2eUiPort}`;
const e2eConfigPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";
const useExternalServers = process.env.E2E_USE_EXTERNAL_SERVERS === "1";

export default defineConfig({
  testDir: "./e2e",
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
            `${shellEnv(createApiServerEnv())} node clients/demo/dist/server.js`,
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
    HOST: e2eHost,
    PORT: e2eApiPort,
    CLIENT_CONFIG_PATH: e2eConfigPath,
    DATABASE_URL: `postgres://agent_chat:agent_chat@${e2eHost}:${e2ePostgresPort}/agent_chat`,
    RUN_MIGRATIONS: "true",
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
