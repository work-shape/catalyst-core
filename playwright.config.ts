import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: "http://127.0.0.1:5273",
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
  webServer: [
    {
      command:
        "COMPOSE_PROJECT_NAME=agent-chat-e2e POSTGRES_HOST_PORT=55433 docker compose -f clients/demo/docker-compose.yml down -v --remove-orphans && COMPOSE_PROJECT_NAME=agent-chat-e2e POSTGRES_HOST_PORT=55433 docker compose -f clients/demo/docker-compose.yml up -d --wait postgres && HOST=127.0.0.1 PORT=4210 CLIENT_CONFIG_PATH=tests/fixtures/e2e-app.yaml DATABASE_URL=postgres://agent_chat:agent_chat@127.0.0.1:55433/agent_chat RUN_MIGRATIONS=true CHAT_UI_ORIGIN=http://127.0.0.1:5273 BETTER_AUTH_URL=http://127.0.0.1:4210/api/auth BETTER_AUTH_SECRET=e2e-better-auth-secret-with-at-least-32-characters E2E_SUPERADMIN_EMAIL=e2e-superadmin@example.test E2E_USER_EMAIL=e2e-user@example.test node clients/demo/dist/server.js",
      url: "http://127.0.0.1:4210/health",
      reuseExistingServer: false,
      timeout: 60_000
    },
    {
      command:
        "pnpm --filter @vivd-catalyst/chat-standalone preview --host 127.0.0.1 --port 5273",
      url: "http://127.0.0.1:5273",
      reuseExistingServer: false,
      timeout: 30_000
    }
  ]
});
