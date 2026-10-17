import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  type CreateClientInstanceKnowledgeWorkerInput,
  createClientInstanceKnowledgeWorker,
  defineClientInstance
} from "@work-shape/catalyst-client-assembly";
import {
  KNOWLEDGE_JOB_KINDS,
  JOB_UNCLAIMED_MS,
  JOB_WORKER_SILENT_MS
} from "@work-shape/catalyst-core";
import { knowledgeModule } from "@work-shape/catalyst-data-stores";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestConfig } from "./support/fixtures";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { deferred, eventually, required, waitUntil } from "./support/assertions";
import {
  useDataStoreInstance,
  clientInstanceId,
  type DataStoreInstance
} from "./support/data-store-instance";
import {
  createManagedObjectTestAttachmentCapability,
  createMultipartFilePayload
} from "./support/chat-server-attachment-harness";
import { getTestJobs, listenTestInstance } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";

const KB = "isolation";
const idSchema = z.object({ id: z.string() });
const documentsSchema = z.object({ documents: z.array(z.object({ state: z.string() })) });

describe("knowledge worker placement", () => {
  it("owns every ingestion kind, excludes extraction and refuses an in-process build", async () => {
    expect(knowledgeModule.jobKinds).toEqual(Object.values(KNOWLEDGE_JOB_KINDS));
    expect(Object.values(KNOWLEDGE_JOB_KINDS)).not.toContain("knowledge_base.extract");
    const input = { config: createTestConfig(), tools: [], capabilities: [], env: {} };
    await expect(createClientInstanceKnowledgeWorker(input)).rejects.toThrow(
      'knowledgeWorker: "separate"'
    );
    const client = defineClientInstance({
      rootDir: new URL("../clients/demo", import.meta.url),
      loadEnv: false
    });
    await expect(client.createKnowledgeWorker(input)).rejects.toThrow(
      'knowledgeWorker: "separate"'
    );
    for (const value of ["0", "-1", "1.5", "", "six"]) {
      await expect(
        createClientInstanceKnowledgeWorker({
          ...input,
          knowledgeWorker: "separate",
          env: { KNOWLEDGE_WORKER_POOL_SIZE: value }
        })
      ).rejects.toThrow("KNOWLEDGE_WORKER_POOL_SIZE must be a positive integer");
    }
  });
});

describe("knowledge worker process isolation", () => {
  const { start } = useDataStoreInstance();

  async function setup(placement?: "separate") {
    const attachments = createManagedObjectTestAttachmentCapability();
    const world = await start(true, undefined, undefined, undefined, {
      attachments: attachments.capability,
      knowledgeWorker: placement
    });
    const params = { kind: "knowledge_base", name: KB };
    expect(
      (
        await world.api.call("assets.put", {
          params,
          payload: {
            config: {
              name: KB,
              title: "Isolation",
              description: "Worker isolation",
              methods: ["keyword"]
            },
            expectedRevision: null
          }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (await world.api.call("assets.publish", { params, payload: { revision: 1 } })).statusCode
    ).toBe(200);
    await eventually(async () => {
      await getTestJobs(world.api).runDue();
      expect(
        await world.stores.dataStores.findDataStoreByName({
          clientInstanceId,
          name: `knowledge-base:${KB}`
        })
      ).toMatchObject({ status: "ready" });
      const state = await world.api.call("knowledge_bases.get", { params: { knowledgeBase: KB } });
      expect(state.json()).toMatchObject({ status: "ok" });
    });
    return world;
  }

  async function add(world: DataStoreInstance, count: number) {
    const created = await world.api.call("conversations.create", { payload: { title: "Import" } });
    expect(created.statusCode).toBe(200);
    const conversationId = idSchema.parse(created.json()).id;
    for (let index = 0; index < count; index++) {
      const upload = createMultipartFilePayload({
        fieldName: "file",
        filename: `${index}.txt`,
        contentType: "text/plain",
        content: `Die Heizung im Gebäude ${index} ist neu.`
      });
      const uploaded = await world.api.call("conversations.draft_attachments.upload", {
        params: { conversationId },
        headers: upload.headers,
        payload: upload.payload
      });
      expect(uploaded.statusCode, uploaded.body).toBe(200);
      const { attachment } = z
        .object({ attachment: z.object({ fileId: z.string() }) })
        .parse(uploaded.json());
      const added = await world.api.call("knowledge_bases.add_files", {
        params: { knowledgeBase: KB },
        payload: { files: [{ conversationId, fileId: attachment.fileId }] }
      });
      expect(added.statusCode, added.body).toBe(200);
    }
    return conversationId;
  }

  async function states(world: DataStoreInstance) {
    const response = await world.api.call("knowledge_bases.list_documents", {
      params: { knowledgeBase: KB }
    });
    expect(response.statusCode, response.body).toBe(200);
    return documentsSchema.parse(response.json()).documents.map((document) => document.state);
  }

  it("returns leased work on SIGTERM and resumes without duplicate documents or chunks", async () => {
    const world = await setup("separate");
    await add(world, 4);
    const record = required(
      await world.stores.dataStores.findDataStoreByName({
        clientInstanceId,
        name: `knowledge-base:${KB}`
      })
    );
    const url = new URL(await fileTestDatabaseUrl());
    url.pathname = `/${record.location.database}`;
    const owned = postgres(url.toString(), { max: 1, onnotice() {} });
    const platform = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
    const locked = deferred<void>();
    const unlock = deferred<void>();
    const blocker = owned.begin(async (tx) => {
      await tx`select sha256 from catalyst_kb.contents for update`;
      locked.resolve();
      await unlock.promise;
    });
    let child: ReturnType<typeof spawn> | undefined;
    let replacement: Awaited<ReturnType<typeof createClientInstanceKnowledgeWorker>> | undefined;
    try {
      await locked.promise;
      child = spawn(
        process.execPath,
        [
          "--experimental-import-meta-resolve",
          new URL("./support/knowledge-isolation-worker.mjs", import.meta.url).pathname
        ],
        {
          stdio: ["ignore", "pipe", "pipe", "ipc"]
        }
      );
      const messages: unknown[] = [];
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("message", (message) => messages.push(message));
      const received = (message: string) =>
        waitUntil(() => {
          if (child?.exitCode !== null) throw new Error(stderr);
          return messages.includes(message);
        }, `worker says ${message}`);
      const input: CreateClientInstanceKnowledgeWorkerInput = {
        config: world.execution.config,
        env: {
          ...world.execution.env,
          KNOWLEDGE_WORKER_ID: "interruptible-knowledge",
          KNOWLEDGE_WORKER_POOL_SIZE: "2"
        },
        tools: [],
        capabilities: [],
        knowledgeWorker: "separate"
      };
      child.send({ type: "start", input });
      await received("ready");
      child.send({ type: "run" });
      await received("running");
      await eventually(async () => {
        const rows = await platform<
          { lease_owner: string }[]
        >`select lease_owner from platform_jobs where kind = 'knowledge_base.index' and status = 'running'`;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.lease_owner === "interruptible-knowledge")).toBe(true);
      });
      child.kill("SIGTERM");
      unlock.resolve();
      await blocker;
      await waitUntil(() => child?.exitCode !== null, "the interrupted worker exits");
      replacement = await createClientInstanceKnowledgeWorker(input);
      await eventually(async () => {
        await replacement?.worker.runDue();
        expect(await states(world)).toEqual(Array(4).fill("indexed"));
      });
      expect(await owned`select count(*)::int as count from catalyst_kb.documents`).toEqual([
        { count: 4 }
      ]);
      expect(await owned`select count(*)::int as count from catalyst_kb.chunks`).toEqual([
        { count: 4 }
      ]);
      expect(
        await platform`select id from platform_jobs where kind = 'knowledge_base.index' and status = 'running'`
      ).toEqual([]);
    } finally {
      unlock.resolve();
      await blocker;
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await replacement?.close();
      await owned.end();
      await platform.end();
    }
  });

  it("keeps the absent-worker default: the API completes the import in process", async () => {
    const world = await setup();
    await add(world, 3);
    await eventually(async () => {
      await getTestJobs(world.api).runDue();
      expect(await states(world)).toEqual(["indexed", "indexed", "indexed"]);
    });
  });

  it("does not claim ingestion in the API and serves HTTP and an agent run while all worker connections are held", async () => {
    const world = await setup("separate");
    const conversationId = await add(world, 8);
    await applyAtCurrentRevisions(world.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "isolation-agent",
          config: {
            name: "isolation-agent",
            displayName: "Isolation agent",
            instructions: "Answer briefly.",
            modelProviderId: "local",
            toolNames: []
          }
        },
        { type: "setDefaultAgent", agentName: "isolation-agent" }
      ]
    });
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
    let child: ReturnType<typeof spawn> | undefined;
    try {
      await getTestJobs(world.api).runDue();
      expect(await states(world)).toEqual(Array(8).fill("pending"));
      expect(
        await sql`select attempts from platform_jobs where kind = 'knowledge_base.index'`
      ).toEqual(Array.from({ length: 8 }, () => ({ attempts: 0 })));
      const infrastructureBefore = await world.api.call("instance.infrastructure.get");
      expect(infrastructureBefore.json()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "knowledge-worker",
            class: "workers",
            check: expect.objectContaining({ status: "failed", errorClass: "no_report" })
          })
        ])
      });
      // A new handler omitted from the central registry would report here even without a job.
      expect(
        await sql`select kind from job_worker_reports where kind like 'knowledge_base.%'`
      ).toEqual([]);
      // No worker means a notice after the queue deadline; recovery is checked below.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + JOB_UNCLAIMED_MS + JOB_WORKER_SILENT_MS + 1000);
      const waiting = await world.api.call("knowledge_bases.get", {
        params: { knowledgeBase: KB }
      });
      expect(waiting.json()).toMatchObject({ processingWaiting: true });
      vi.useRealTimers();
      const url = new URL(await fileTestDatabaseUrl());
      url.searchParams.set("application_name", "knowledge-isolation-worker");
      child = spawn(
        process.execPath,
        [
          "--experimental-import-meta-resolve",
          new URL("./support/knowledge-isolation-worker.mjs", import.meta.url).pathname
        ],
        {
          stdio: ["ignore", "pipe", "pipe", "ipc"]
        }
      );
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      const messages: unknown[] = [];
      child.on("message", (message) => messages.push(message));
      const received = (message: string) =>
        waitUntil(() => {
          if (child?.exitCode !== null) throw new Error(`Worker exited: ${stderr}`);
          return messages.includes(message);
        }, `worker says ${message}`);
      child.send({
        type: "start",
        input: {
          config: world.execution.config,
          env: {
            ...world.execution.env,
            DATABASE_URL: url.toString(),
            KNOWLEDGE_WORKER_ID: "isolated-knowledge",
            KNOWLEDGE_WORKER_POOL_SIZE: "2"
          }
        }
      });
      await received("ready");
      child.send({ type: "saturate", slots: 2 });
      await received("saturated");
      child.send({ type: "run" });
      await received("running");
      const [{ connections } = { connections: 0 }] = await sql<{ connections: number }[]>`
        select count(*)::int as connections from pg_stat_activity
        where application_name = 'knowledge-isolation-worker' and state = 'idle in transaction'`;
      expect(connections).toBe(2);
      getTestJobs(world.api).start();
      const baseUrl = await listenTestInstance(world.api);
      const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
      expect(health.status).toBe(200);
      const started = await world.api.call("conversations.runs.start", {
        params: { conversationId },
        payload: { idempotencyKey: "isolated-turn", message: { text: "Still responsive" } }
      });
      expect(started.statusCode, started.body).toBe(200);
      await eventually(async () => {
        const rows =
          await sql`select status from agent_runs where conversation_id = ${conversationId}`;
        expect(rows).toEqual([{ status: "completed" }]);
      });
      // Due ingestion still cannot advance through its held pool; the API has its own.
      expect(await states(world)).toEqual(Array(8).fill("pending"));
      child.send({ type: "release" });
      await received("released");
      await eventually(async () => {
        expect(await states(world)).toEqual(Array(8).fill("indexed"));
      });
      expect(
        (await world.api.call("knowledge_bases.get", { params: { knowledgeBase: KB } })).json()
      ).toMatchObject({ processingWaiting: false });
      const search = await world.api.call("knowledge_bases.search", {
        params: { knowledgeBase: KB },
        payload: { query: "Heizung" }
      });
      expect(search.statusCode, search.body).toBe(200);
      expect(
        z.object({ passages: z.array(z.unknown()) }).parse(search.json()).passages.length
      ).toBeGreaterThan(0);
      const infrastructureAfter = await world.api.call("instance.infrastructure.get");
      expect(infrastructureAfter.json()).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            id: "knowledge-worker",
            check: expect.objectContaining({ status: "ok" })
          })
        ])
      });
      expect(
        await sql`select kind from job_worker_reports where kind like 'knowledge_base.%' order by kind`
      ).toEqual(
        Object.values(KNOWLEDGE_JOB_KINDS)
          .sort()
          .map((kind) => ({ kind }))
      );
      // Exactly one successful attempt for each document after the worker recovered.
      expect(
        await sql`select status, attempts from platform_jobs where kind = 'knowledge_base.index'`
      ).toEqual(Array.from({ length: 8 }, () => ({ status: "succeeded", attempts: 1 })));
    } finally {
      vi.useRealTimers();
      if (child && child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await sql.end();
    }
  });
});
