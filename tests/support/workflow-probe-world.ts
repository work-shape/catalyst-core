import { execFile, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type postgres from "postgres";
import { z } from "zod";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import { WORKFLOW_ASSET_KIND, asClientInstanceId, asUserId } from "@vivd-catalyst/core";
import { waitUntil } from "./assertions";
import { statuses } from "./connection-discovery-world";
import { createTestConfig } from "./fixtures";
import {
  rpcId,
  startMcpTestServer,
  textResult,
  tool,
  type McpTestRequest
} from "./mcp-test-server";
import { generateSecretStoreKey, generateTestSecret } from "./test-connector";
import { fileTestDatabaseUrl } from "./test-database";
import { createTestInstance, type TestInstance } from "./test-instance";
import { killTestProcess, startTestProcess } from "./test-process";
import { withTestSql } from "./test-sql";
import { WORKFLOW_RUNNER, runSchema } from "./workflow-instance";

// The world of the probes of the Workflow engine: an outside system that speaks MCP in the
// process of the probe, the server of an assembled instance in a process of its own, whose
// job worker runs the steps as the server of a deployment does, and a second assembly of the
// same instance in the process of the probe, which never runs a job: the probe writes and
// reads through its API while the other process is killed and started again.

/** A bound on a hang: the process starts through the TypeScript loader. */
const STARTED_WITHIN_MS = 120_000;

const execFileAsync = promisify(execFile);
const callSchema = z.object({ params: z.object({ name: z.string() }) });

/** The header the outside system reads the key of a changing call from. */
const KEY_HEADER = "Idempotency-Key";

/**
 * The tools of the outside system: two that read and two that change. `charge` is declared
 * with the header that carries its key; `charge_unkeyed` is the same call without it.
 */
const TOOLS = [
  { name: "slow_read", effect: "reading" },
  { name: "echo", effect: "reading" },
  { name: "charge", effect: "changing", idempotencyKeyHeader: KEY_HEADER },
  { name: "charge_unkeyed", effect: "changing" }
] as const;
type ToolName = (typeof TOOLS)[number]["name"];

export interface ProbeWorker {
  /** The process id of the server, which the probe started and alone may kill. */
  readonly pid: number;
  /** The resident set of the process now, in bytes. */
  residentBytes(): Promise<number>;
  /** The largest resident set the process had when it was sampled, in bytes. */
  peakResidentBytes(): number;
  /** Ends the process as the kernel does: `SIGKILL`, with no chance to clean up. */
  kill(): Promise<void>;
}

export interface ProbeWorld {
  /** The API of the instance in this process. It runs no job. */
  api: TestInstance;
  /** How often the outside system was asked to run a tool. */
  arrivals(name: ToolName): number;
  /** The key each call of a tool arrived with, in order. `undefined` for a call without one. */
  keys(name: ToolName): (string | undefined)[];
  /** The next call of the tool gets no answer until `release`. */
  hold(name: ToolName): void;
  /** Answers every held call, where somebody still listens. */
  release(): void;
  /** Starts the server of the instance in a process of its own. Its worker runs the steps. */
  startWorker(): Promise<ProbeWorker>;
  /** Writes and publishes a Workflow as the asset of the instance. */
  publish(manifest: { id: string }): Promise<void>;
  start(workflow: string, input: Record<string, unknown>): Promise<z.infer<typeof runSchema>>;
  run(runId: string): Promise<z.infer<typeof runSchema>>;
  sql<Result>(query: (sql: postgres.Sql) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

async function residentBytes(pid: number): Promise<number> {
  const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
  // Kilobytes on macOS and on Linux.
  return Number(stdout.trim()) * 1_024;
}

/** Opens the world with its first server process, which has discovered the Connection. */
export async function openProbeWorld(): Promise<{ world: ProbeWorld; worker: ProbeWorker }> {
  const closing: (() => Promise<unknown>)[] = [];
  const close = async () => {
    for (const end of closing.splice(0).reverse()) await end();
  };
  try {
    const key = generateTestSecret();
    const arrived = new Map<string, (string | undefined)[]>();
    const holding = new Set<string>();
    const held: { request: McpTestRequest; response: ServerResponse }[] = [];
    const answer = (request: McpTestRequest, response: ServerResponse) => {
      if (response.destroyed) return;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ jsonrpc: "2.0", id: rpcId(request.body), result: textResult("ok") })
      );
    };
    const outside = await startMcpTestServer({
      tools: TOOLS.map(({ name }) => tool(name)),
      requireHeader: { name: "authorization", value: `Bearer ${key}` },
      intercept(request, response) {
        if (request.rpc !== "tools/call") return false;
        const { name } = callSchema.parse(request.body).params;
        const key = request.headers[KEY_HEADER.toLowerCase()];
        arrived.set(name, [
          ...(arrived.get(name) ?? []),
          typeof key === "string" ? key : undefined
        ]);
        if (!holding.delete(name)) return false;
        held.push({ request, response });
        return true;
      },
      call: () => textResult("ok")
    });
    closing.push(() => outside.close());

    const config = parseClientInstanceConfig({
      ...createTestConfig({
        developmentAuth: {
          enabled: true,
          user: {
            id: "user-1",
            externalUserId: "user-1",
            displayLabel: "User",
            roles: ["user", "admin", "superadmin"]
          }
        }
      }),
      modules: {
        assetManagement: { enabled: true },
        connections: { enabled: true },
        workflows: { enabled: true }
      },
      administration: { agentConfiguration: { enabled: true, allowSkillEditing: true } },
      connections: {
        outside: {
          connectorType: "mcp",
          displayName: "Outside system",
          settings: { url: `http://127.0.0.1:${outside.port}/mcp` },
          authScheme: "bearer",
          secret: "OUTSIDE_MCP_KEY",
          operations: TOOLS.map((tool) => ({ ...tool, exposure: ["workflow"] }))
        }
      },
      // A Workflow has nobody to confirm a changing call.
      policy: { defaults: { changing: "allow" } },
      secretStore: { keys: [{ id: "k1", ref: "CATALYST_SECRET_STORE_KEY" }] },
      egress: {
        allow: [
          {
            protocol: "http",
            host: "127.0.0.1",
            port: outside.port,
            network: "private",
            cidrs: ["127.0.0.1/32"]
          }
        ]
      }
    });
    const env = { CATALYST_SECRET_STORE_KEY: generateSecretStoreKey(), OUTSIDE_MCP_KEY: key };
    const clientInstanceId = asClientInstanceId(config.clientInstance.id);

    const api = await createTestInstance({ config, env, tools: [] });
    closing.push(() => api.close());
    const directory = await mkdtemp(join(tmpdir(), "catalyst-workflow-probe-"));
    closing.push(() => rm(directory, { recursive: true, force: true }));
    const configPath = join(directory, "app.yaml");
    // JSON is YAML.
    await writeFile(configPath, JSON.stringify(config));
    const databaseUrl = await fileTestDatabaseUrl();

    const principal = await api.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: WORKFLOW_RUNNER
    });
    const starter = await api.stores.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "test",
      externalUserId: "user-1",
      displayLabel: "user-1",
      roles: ["user", "admin", "superadmin"],
      permissionRefs: [],
      permissions: [],
      correlationId: "probe"
    });
    await api.stores.access.createGrant({
      clientInstanceId,
      // AP-10: the grant is written to the store; its administration does not give it yet.
      holderKind: "service_principal",
      holderId: principal.id,
      action: "connection.use",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: asUserId(starter.id)
    });

    const children: ChildProcess[] = [];
    closing.push(async () => {
      for (const child of children.splice(0)) await killTestProcess(child);
    });
    let started = 0;
    const world: ProbeWorld = {
      api,
      arrivals: (name) => arrived.get(name)?.length ?? 0,
      keys: (name) => arrived.get(name) ?? [],
      hold(name) {
        holding.add(name);
      },
      release() {
        for (const { request, response } of held.splice(0)) answer(request, response);
      },
      async startWorker() {
        started += 1;
        const applicationName = `workflow_probe_worker_${started}`;
        const url = new URL(databaseUrl);
        url.searchParams.set("application_name", applicationName);
        const child = startTestProcess(new URL("./instance-process.ts", import.meta.url), {
          args: ["server", "without-capability"],
          env: {
            PATH: process.env.PATH,
            CLIENT_CONFIG_PATH: configPath,
            DATABASE_URL: url.toString(),
            // Any free port: the probe speaks to the API of its own process.
            PORT: "0",
            ...env
          },
          stdio: ["ignore", "pipe", "inherit"]
        });
        children.push(child);
        child.stdout?.pipe(createWriteStream(join(directory, `${applicationName}.log`)));
        const pid = child.pid;
        if (pid === undefined) throw new Error("The server process did not start");
        let ended = false;
        child.once("exit", () => {
          ended = true;
        });
        let peak = 0;
        const sample = () => {
          if (ended) return;
          residentBytes(pid).then(
            (bytes) => {
              peak = Math.max(peak, bytes);
            },
            () => undefined
          );
        };
        const sampling = setInterval(sample, 500);
        child.once("exit", () => clearInterval(sampling));
        // The worker of the server has asked for its jobs.
        await waitUntil(
          async () => {
            if (ended) throw new Error("The server process ended while it started");
            const rows = await world.sql(
              (sql) => sql`
                select 1 from pg_stat_activity
                where application_name = ${applicationName} and query like '%platform_jobs%'`
            );
            return rows.length > 0;
          },
          "the server process has asked for its jobs",
          STARTED_WITHIN_MS
        );
        return {
          pid,
          residentBytes: () => residentBytes(pid),
          peakResidentBytes: () => peak,
          kill: () => killTestProcess(child)
        };
      },
      async publish(manifest) {
        const address = { kind: WORKFLOW_ASSET_KIND, name: manifest.id };
        const written = await api.call("assets.put", {
          params: address,
          payload: { config: { name: manifest.id, manifest }, expectedRevision: null }
        });
        if (written.statusCode !== 200)
          throw new Error(`The Workflow was refused: ${written.body}`);
        const { revision } = z.object({ revision: z.number() }).parse(written.json());
        const published = await api.call("assets.publish", {
          params: address,
          payload: { revision }
        });
        if (published.statusCode !== 200) {
          throw new Error(`The Workflow was not published: ${published.body}`);
        }
      },
      async start(workflow, input) {
        const response = await api.call("workflows.start", {
          params: { workflow },
          payload: { input }
        });
        if (response.statusCode !== 200) throw new Error(`The run did not start: ${response.body}`);
        return runSchema.parse(response.json());
      },
      async run(runId) {
        return runSchema.parse((await api.call("workflows.get_run", { params: { runId } })).json());
      },
      sql: withTestSql,
      close
    };

    // The first process discovers what the Connection offers; until then no step may call it.
    const worker = await world.startWorker();
    await waitUntil(
      async () =>
        Object.values(await statuses(api, "outside")).filter((status) => status === "ready")
          .length === TOOLS.length,
      "the operations of the Connection are discovered",
      STARTED_WITHIN_MS
    );
    return { world, worker };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Keeps what a probe measured as `workflow-<name>-probe.json`, in the directory
 * `WORKFLOW_PROBE_RECORDS` names or in `catalyst-workflow-probes` under the one for temporary
 * files, where the script of the probes reads them. Answers the path.
 */
export async function writeProbeRecord(name: string, record: unknown): Promise<string> {
  const directory =
    process.env.WORKFLOW_PROBE_RECORDS ?? join(tmpdir(), "catalyst-workflow-probes");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `workflow-${name}-probe.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

/** Waits for a condition of the database or the API without asking twenty times a second. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

/** Whether a run has ended, whatever as. */
export const ended = (run: { status: string }) =>
  !["queued", "running", "waiting"].includes(run.status);
