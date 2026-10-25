import { describe, expect, it } from "vitest";
import { runCli } from "@work-shape/catalyst-cli";
import {
  asUserId,
  KNOWLEDGE_FIRST_PASS_STOP,
  knowledgeSourcesOutputSchema,
  LEGACY_LIST_GRANTOR
} from "@work-shape/catalyst-core";
import { eventually, required } from "./support/assertions";
import { clientInstanceId } from "./support/data-store-instance";
import { createTestFetch } from "./support/test-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";
import {
  item,
  operationRunOf,
  SOURCE as WORKFLOW_SOURCE,
  useKnowledgeWorkflow
} from "./support/knowledge-workflow";

// KB-ISO-1b, Data Stores And Knowledge Bases check 99: a source's first pass above the stop
// fetches and indexes up to it, waits as "Wartet auf Bestätigung" with count, size and the
// estimated cost, and goes on after a holder of `knowledge_base.publish` confirms. A smaller
// source never waits. The stop here is 150 instead of 10,000, so a small fixture crosses it;
// the scale suite crosses the real one.

const KB = "sync-test";
const SOURCE = "source";
const STOP = 150;

type World = Awaited<ReturnType<ReturnType<typeof useKnowledgeSync>["setup"]>>;

async function sourceStatus(world: Pick<World, "instance">, id: string) {
  const answer = await world.instance.api.call("knowledge_bases.sources", {
    params: { knowledgeBase: KB }
  });
  expect(answer.statusCode, answer.body).toBe(200);
  return required(
    knowledgeSourcesOutputSchema.parse(answer.json()).sources.find((source) => source.id === id)
  );
}

describe("the first import stops for a confirmation (KB-ISO-1b)", { timeout: 600_000 }, () => {
  const { setup } = useKnowledgeSync({ firstPassStop: STOP });

  it("fetches up to the stop, waits with the estimate, and finishes once a publisher confirms", async () => {
    const world = await setup();
    const text = new TextEncoder().encode("Searchable text of a synced document.");
    for (let i = 0; i < 230; i++)
      world.world.put({ folderId: "folder", name: `${i}.txt`, mime: "text/plain", bytes: text });
    const run = await world.sync();
    const waiting = await eventually(async () => {
      await world.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
      await world.worker.runDue();
      const [fetched] =
        await world.sql`select count(*)::int as n from catalyst_kb.source_items where state = 'fetched'`;
      expect(fetched?.n).toBe(STOP);
      const status = await sourceStatus(world, SOURCE);
      expect(status.confirmation).toBeDefined();
      return status;
    }, 180_000);
    // Nothing past the stop is fetched while it waits, and the run keeps running.
    expect(
      await world.sql`select state, count(*)::int as n from catalyst_kb.source_items group by state order by state`
    ).toEqual([
      { state: "discovered", n: 230 - STOP },
      { state: "fetched", n: STOP }
    ]);
    expect(await world.sql`select state from catalyst_kb.sync_runs where id = ${run}`).toEqual([
      { state: "running" }
    ]);
    expect(waiting).toMatchObject({
      running: { mode: "initial" },
      confirmation: {
        syncRunId: run,
        items: 230,
        bytes: 230 * text.length,
        stop: STOP,
        tokens: { min: expect.any(Number), max: expect.any(Number) },
        passages: { min: 230, max: expect.any(Number) },
        room: true
      }
    });
    expect(waiting).not.toHaveProperty("running.estimatedEndAt");

    // Who may change it but not publish it cannot let it go on.
    const writer = await world.instance.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Writer",
      permissions: ["config_assets.read", "config_assets.write"]
    });
    for (const action of ["knowledge_base.read", "knowledge_base.write"])
      await world.instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: writer.id,
        action,
        effect: "allow",
        scopeKind: "asset",
        scopeId: world.record.id,
        grantedBy: asUserId(LEGACY_LIST_GRANTOR)
      });
    const { secret } = await world.instance.stores.apiAccess.createApiCredential({
      clientInstanceId,
      servicePrincipalId: writer.id,
      name: "Write",
      scopes: ["config_assets:read", "config_assets:write"]
    });
    const token = await world.instance.api.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${secret}` }
    });
    expect(token.statusCode, token.body).toBe(200);
    const refused = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, confirm: true },
      headers: { authorization: `Bearer ${token.json<{ accessToken: string }>().accessToken}` }
    });
    expect(refused.statusCode, refused.body).toBe(403);
    // The CLI's `--confirm` asks the same: without it, the same key would start a sync.
    const stderr: string[] = [];
    const cli = await runCli(
      [
        "knowledge-base",
        "sync",
        KB,
        "--source",
        SOURCE,
        "--confirm",
        "--instance",
        "https://catalyst.test",
        "--json"
      ],
      {
        cwd: world.instance.filesRoot,
        env: { CATALYST_API_KEY: secret },
        fetchImpl: createTestFetch(world.instance.api),
        stdout: () => undefined,
        stderr: (text: string) => {
          stderr.push(text);
        }
      }
    );
    expect(cli).not.toBe(0);
    expect(stderr.join("")).toMatch(/forbidden|publish|403/iu);

    const confirmed = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, confirm: true }
    });
    // The call joins the waiting sync run, as a sync while one runs does.
    expect(confirmed.statusCode, confirmed.body).toBe(202);
    expect(confirmed.json<{ id: string }>().id).not.toBe("operation");
    await world.drain(run);
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
      { n: 230 }
    ]);
    const status = await sourceStatus(world, SOURCE);
    expect(status).not.toHaveProperty("confirmation");
    expect(status).toMatchObject({ last: { state: "done", mode: "initial" } });

    // The confirmation is audited once, with counts and the estimate and never a name.
    const events = (
      await world.instance.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })
    ).filter((event) => event.type === "knowledge_base.first_pass_confirmed");
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({
      source: SOURCE,
      syncRunId: run,
      items: 230,
      stop: STOP,
      tokensMin: expect.any(Number),
      tokensMax: expect.any(Number)
    });
    expect(JSON.stringify(events[0]?.metadata)).not.toMatch(/\.txt/u);

    // A later pass never waits, however much it lists.
    for (let i = 230; i < 400; i++)
      world.world.put({ folderId: "folder", name: `${i}.txt`, mime: "text/plain", bytes: text });
    await world.drain(await world.sync("full"));
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
      { n: 400 }
    ]);
  });

  it("never stops a first import at or below the stop", async () => {
    const world = await setup();
    for (let i = 0; i < STOP; i++)
      world.world.put({
        folderId: "folder",
        name: `${i}.txt`,
        mime: "text/plain",
        bytes: new TextEncoder().encode(`Small source item ${i}`)
      });
    await world.drain(await world.sync());
    expect(await world.sql`select count(*)::int as n from catalyst_kb.documents`).toEqual([
      { n: STOP }
    ]);
    expect(
      (await world.instance.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })).some(
        (event) => event.type === "knowledge_base.first_pass_confirmed"
      )
    ).toBe(false);
  });

  it("keeps the real stop at the default of knowledge.maxDocuments", () => {
    expect(KNOWLEDGE_FIRST_PASS_STOP).toBe(10_000);
  });
});

describe("a keyword-only first import that waits (KB-ISO-1b review)", { timeout: 600_000 }, () => {
  const { setup } = useKnowledgeSync({ firstPassStop: STOP, methods: ["keyword"] });

  it("states count and size only: nothing is embedded, so no tokens, passages or room", async () => {
    const world = await setup();
    const text = new TextEncoder().encode("Searchable text of a synced document.");
    for (let i = 0; i < 230; i++)
      world.world.put({ folderId: "folder", name: `${i}.txt`, mime: "text/plain", bytes: text });
    const run = await world.sync();
    const waiting = await eventually(async () => {
      await world.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
      await world.worker.runDue();
      const status = await sourceStatus(world, SOURCE);
      expect(status.confirmation).toBeDefined();
      return required(status.confirmation);
    }, 180_000);
    expect(waiting).toMatchObject({ syncRunId: run, items: 230, stop: STOP });
    for (const absent of ["tokens", "passages", "model", "cost", "room", "addedBytes"])
      expect(waiting).not.toHaveProperty(absent);

    const confirmed = await world.instance.api.call("knowledge_bases.sync", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, confirm: true }
    });
    expect(confirmed.statusCode, confirmed.body).toBe(202);
    await world.drain(run);
    const [event] = (
      await world.instance.stores.audit.listAuditEvents({ clientInstanceId, limit: 200 })
    ).filter((each) => each.type === "knowledge_base.first_pass_confirmed");
    expect(event?.metadata).toMatchObject({ items: 230, stop: STOP });
    expect(event?.metadata).not.toHaveProperty("tokensMin");
  });
});

describe(
  "a Workflow's first ingest stops for a confirmation (KB-ISO-1b)",
  { timeout: 600_000 },
  () => {
    const { world } = useKnowledgeWorkflow({ firstPassStop: STOP });

    it("takes the items up to the stop while the step waits, and the rest after a confirmation", async () => {
      const w = await world();
      const run = await w.startRun();
      const rows = Array.from({ length: 230 }, (_, n) => item(n));
      const operationRunId = operationRunOf(
        await run.call("ingest", { dataset: await run.dataset(rows) })
      );
      const waiting = await eventually(async () => {
        await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
        await w.worker.runDue();
        expect(await w.states()).toEqual({ fetched: STOP });
        const status = await sourceStatus(w, WORKFLOW_SOURCE);
        expect(status.confirmation).toBeDefined();
        return status;
      }, 180_000);
      expect(waiting).toMatchObject({
        running: { mode: "ingest" },
        confirmation: { items: 230, stop: STOP }
      });
      // The step's call still runs: it waits for the rest.
      expect(
        (
          await w.instance.stores.operationRuns.get({
            clientInstanceId,
            id: operationRunId
          })
        )?.status
      ).toBe("running");

      const confirmed = await w.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: KB },
        payload: { source: WORKFLOW_SOURCE, confirm: true }
      });
      expect(confirmed.statusCode, confirmed.body).toBe(202);
      // Its own run ends at once, and the answer says so: the pass it lets go on is the step's.
      expect(confirmed.json<{ status: string }>().status).toBe("done");
      expect(
        await w.instance.stores.operationRuns.get({
          clientInstanceId,
          id: confirmed.json<{ id: string }>().id
        })
      ).toMatchObject({ status: "done", output: { value: { confirmed: true } } });
      const ended = await w.settle(operationRunId);
      expect(ended.output?.value).toMatchObject({ accepted: 230, done: 230, failed: 0 });
      expect(await w.states()).toEqual({ fetched: 230 });

      // A confirmation with nothing waiting is refused for a Workflow's source.
      const again = await w.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: KB },
        payload: { source: WORKFLOW_SOURCE, confirm: true }
      });
      expect(again.statusCode, again.body).toBe(409);

      // Its second pass is not its first: it never waits.
      const later = await w.startRun();
      const second = operationRunOf(
        await later.call("ingest", {
          dataset: await later.dataset(Array.from({ length: 300 }, (_, n) => item(n + 1000)))
        })
      );
      expect((await w.settle(second)).output?.value).toMatchObject({ accepted: 300, done: 300 });
    });

    it("goes on after a confirmation that comes once the run has ended, and withdraws nothing", async () => {
      const w = await world();
      const run = await w.startRun();
      const operationRunId = operationRunOf(
        await run.call("ingest", {
          dataset: await run.dataset(Array.from({ length: 230 }, (_, n) => item(n))),
          complete: true
        })
      );
      await eventually(async () => {
        await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
        await w.worker.runDue();
        expect((await sourceStatus(w, WORKFLOW_SOURCE)).confirmation).toBeDefined();
      }, 180_000);
      // The step's timeout ended the run, as `operation_still_running` does; the pass waits on.
      await run.end("failed");
      // Its next look, which waits on the confirmation, finds it still waiting.
      await w.platform`update platform_job_wakes set run_after = now() where kind like 'knowledge_base.%'`;
      await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
      await w.worker.runDue();
      expect((await sourceStatus(w, WORKFLOW_SOURCE)).confirmation).toBeDefined();
      const confirmed = await w.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: KB },
        payload: { source: WORKFLOW_SOURCE, confirm: true }
      });
      expect(confirmed.statusCode, confirmed.body).toBe(202);
      // Its step has ended: the run keeps the count of its failures, with no step to hold them.
      const ended = await w.settle(operationRunId);
      expect(ended.output?.value).toEqual({ accepted: 230, done: 230, failed: 0, withdrawn: 0 });
      await w.settlePasses();
      expect(await w.states()).toEqual({ fetched: 230 });
      expect(
        await w.sql`select pass_state from catalyst_kb.sync_runs where source_id = ${WORKFLOW_SOURCE}`
      ).toEqual([{ pass_state: "dropped" }]);
    });

    it("counts the passes of one run together, so splitting the items does not pass the stop", async () => {
      const w = await world();
      const run = await w.startRun();
      const first = operationRunOf(
        await run.call("ingest", {
          dataset: await run.dataset(Array.from({ length: 120 }, (_, n) => item(n)))
        })
      );
      expect((await w.settle(first)).output?.value).toMatchObject({ accepted: 120, done: 120 });
      const second = operationRunOf(
        await run.call("ingest", {
          dataset: await run.dataset(Array.from({ length: 110 }, (_, n) => item(n + 120)))
        })
      );
      const waiting = await eventually(async () => {
        await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
        await w.worker.runDue();
        expect(await w.states()).toEqual({ fetched: STOP });
        const status = await sourceStatus(w, WORKFLOW_SOURCE);
        expect(status.confirmation).toBeDefined();
        return status;
      }, 180_000);
      expect(waiting.confirmation).toMatchObject({ items: 230, stop: STOP });

      // Another Knowledge Base holds nothing of this source to confirm.
      const other = await w.addKnowledgeBase("other-kb", "Other");
      await other.sql.end();
      const elsewhere = await w.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: "other-kb" },
        payload: { source: WORKFLOW_SOURCE, confirm: true }
      });
      expect(elsewhere.statusCode, elsewhere.body).toBe(409);
      expect((await sourceStatus(w, WORKFLOW_SOURCE)).confirmation).toBeDefined();

      const confirmed = await w.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: KB },
        payload: { source: WORKFLOW_SOURCE, confirm: true }
      });
      expect(confirmed.statusCode, confirmed.body).toBe(202);
      expect((await w.settle(second)).output?.value).toMatchObject({ accepted: 110, done: 110 });
      expect(await w.states()).toEqual({ fetched: 230 });

      // Once confirmed, a later pass of the same run does not stop again.
      const third = operationRunOf(
        await run.call("ingest", {
          dataset: await run.dataset(Array.from({ length: 60 }, (_, n) => item(n + 230)))
        })
      );
      expect((await w.settle(third)).output?.value).toMatchObject({ accepted: 60, done: 60 });
    });

    it.each([
      ["confirmed after", true],
      ["never confirmed once", false]
    ])("ends a pass %s its run's dataset expired, withdrawing nothing", async (_label, confirm) => {
      const w = await world();
      const run = await w.startRun();
      const rows = await run.dataset(Array.from({ length: 230 }, (_, n) => item(n)));
      const operationRunId = operationRunOf(
        await run.call("ingest", { dataset: rows, complete: true })
      );
      await eventually(async () => {
        await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
        await w.worker.runDue();
        expect((await sourceStatus(w, WORKFLOW_SOURCE)).confirmation).toBeDefined();
      }, 180_000);
      await run.end("failed");
      // Seven days on, the failed run's datasets are gone.
      await w.platform`update workflow_run_datasets set state = 'deleted' where id = ${rows.$dataset}`;
      if (confirm) {
        const confirmed = await w.instance.api.call("knowledge_bases.sync", {
          params: { knowledgeBase: KB },
          payload: { source: WORKFLOW_SOURCE, confirm: true }
        });
        expect(confirmed.statusCode, confirmed.body).toBe(202);
      }
      const ended = await eventually(async () => {
        await w.platform`update platform_job_wakes set run_after = now() where kind like 'knowledge_base.%'`;
        await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
        await w.worker.runDue();
        const call = await w.instance.stores.operationRuns.get({
          clientInstanceId,
          id: operationRunId
        });
        expect(call?.status).toBe("failed");
        return required(call);
      }, 180_000);
      expect(ended.error?.code).toBe("knowledge_ingest_cancelled");
      expect(await w.states()).toEqual({ fetched: STOP });
      const status = await sourceStatus(w, WORKFLOW_SOURCE);
      expect(status).not.toHaveProperty("confirmation");
      expect(status).not.toHaveProperty("running");
      expect(
        await w.sql`select state, pass_state from catalyst_kb.sync_runs where source_id = ${WORKFLOW_SOURCE}`
      ).toEqual([{ state: "failed", pass_state: "dropped" }]);
    });
  }
);
