import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { expect } from "./test";

// A second API of the suite's instance with the module `knowledge` on, on the same database:
// the suite's own runs without it. Its worker claims jobs through the same leases as the main
// API, with the same tools and config plus knowledge indexing and source syncs.

const host = process.env.E2E_HOST ?? "127.0.0.1";
const apiBaseUrl = process.env.E2E_API_URL ?? `http://${host}:4210`;
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  `postgres://agent_chat:agent_chat@${host}:${process.env.E2E_POSTGRES_PORT ?? "55433"}/agent_chat`;
const configPath = process.env.E2E_CONFIG_PATH ?? "tests/fixtures/e2e-app.yaml";

export interface KnowledgeApi {
  url: string;
  stop(): Promise<void>;
}

/**
 * Starts the API on the suite's port plus `portOffset`, which no other spec takes, with its
 * config written to `configName` beside the suite's.
 */
export async function startKnowledgeApi(
  portOffset: number,
  configName: string
): Promise<KnowledgeApi> {
  const port = Number(new URL(apiBaseUrl).port) + portOffset;
  const url = `http://${host}:${port}`;
  const onConfigPath = resolve(dirname(resolve(configPath)), configName);
  const config = (await readFile(configPath, "utf8")).replaceAll(apiBaseUrl, url);
  await mkdir(dirname(onConfigPath), { recursive: true });
  const section = /^modules:\n/mu;
  expect(section.test(config)).toBe(true);
  await writeFile(
    onConfigPath,
    config.replace(section, "modules:\n  knowledge:\n    enabled: true\n")
  );
  const api = spawn(process.execPath, ["clients/demo/dist/e2e-server.js"], {
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      CLIENT_CONFIG_PATH: onConfigPath,
      DATABASE_URL: databaseUrl,
      CHAT_UI_ORIGIN: process.env.E2E_UI_URL ?? `http://${host}:5273`,
      BETTER_AUTH_URL: `${url}/api/auth`,
      // The secret of the suite's own API: both sign the sessions of one database.
      BETTER_AUTH_SECRET: "e2e-better-auth-secret-with-at-least-32-characters",
      E2E_SUPERADMIN_EMAIL: "e2e-superadmin@example.test",
      E2E_USER_EMAIL: "e2e-user@example.test",
      CHAT_SESSION_TOKEN_SECRET:
        process.env.CHAT_SESSION_TOKEN_SECRET ??
        "e2e-session-token-secret-with-at-least-24-characters",
      CHAT_SERVER_CREDENTIAL:
        process.env.CHAT_SERVER_CREDENTIAL ?? "e2e-server-to-server-credential",
      SERVICE_ACCESS_TOKEN_SECRET:
        process.env.SERVICE_ACCESS_TOKEN_SECRET ??
        "e2e-service-access-token-secret-with-32-characters"
    },
    stdio: "inherit"
  });
  await expect
    .poll(
      async () => {
        if (api.exitCode !== null) throw new Error("The API with knowledge on stopped");
        try {
          return (await fetch(`${url}/health`)).status;
        } catch {
          return 0;
        }
      },
      { timeout: 60_000 }
    )
    .toBe(200);
  return {
    url,
    stop: async () => {
      if (api.exitCode !== null) return;
      const exited = new Promise((done) => api.once("exit", done));
      api.kill("SIGTERM");
      await exited;
    }
  };
}
