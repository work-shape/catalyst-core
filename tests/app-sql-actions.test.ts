import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { combineDataToolSources, createAppActionToolSource } from "@work-shape/catalyst-server";
import { createConnectionToolSource } from "@work-shape/catalyst-connections";
import { asUserId, type AuditEvent, type OperationRun } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { resultSchema } from "./support/app-actions";
import { expectStatus } from "./support/app-instance";
import { agentOrigin } from "./support/connection-operations";
import { finding, init, manifest } from "./support/data-store-world";
import {
  UNLISTED_STORE_APP,
  findingsApp,
  setupFindingsApp,
  type FindingsWorld
} from "./support/findings-app";

// An `sql` action of an App, called by its frame through the interface, on a real database of
// a Data Store: the real build compiles the statement, the real call path runs it, and the
// store's own operations read and add the rows as the store's app role. The right to the
// store is checked on the App: its publisher was asked for it, and `kai`, a member of the
// App's workspace who holds no right on the store, reads and adds through the published App.
// The administrator holds the rights of the kind by role.
//
// Every test here fails without the change: before it the build refused a manifest with
// `dataStores`, so no App with a statement could be stored.

const rowsSchema = z.object({
  columns: z.array(z.object({ name: z.string(), type: z.string(), nativeType: z.string() })),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean()
});

describe("a statement of an App on a Data Store", () => {
  let t: FindingsWorld;
  beforeAll(async () => {
    t = await setupFindingsApp();
  });
  afterAll(() => t.closeAll());

  /** Calls an action of the published App `app` as `userId` and reads the rows it answered. */
  async function rowsOf(userId: string, name: string, input: unknown, app = "findings") {
    const frame = await t.openApp(userId, "published", app);
    const response = await t.callAction(userId, frame, name, input);
    expectStatus(response, 200);
    const answer = resultSchema.parse(response.json());
    return { ...rowsSchema.parse(answer.result), runId: answer.runId, frame };
  }

  /** Every run and every audit event of the instance, the events paged through. */
  async function kept(): Promise<{ runs: OperationRun[]; audit: AuditEvent[] }> {
    const audit: AuditEvent[] = [];
    for (;;) {
      const last = audit.at(-1);
      const page = await t.stores.audit.listAuditEvents({
        clientInstanceId,
        page: { limit: 200, ...(last ? { after: [last.createdAt, last.id] } : {}) }
      });
      audit.push(...page);
      if (page.length < 200) break;
    }
    return { runs: await t.stores.operationRuns.list({ clientInstanceId }), audit };
  }

  /**
   * Runs `work` while `userId` holds a right on the store `findings`, or is denied it, and
   * takes the grant back. It is written as a row: the API grants no right on one Data Store yet.
   */
  async function withStoreRight(
    userId: string,
    action: string,
    work: () => Promise<void>,
    effect: "allow" | "deny" = "allow"
  ) {
    const grant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: userId,
      action,
      effect,
      scopeKind: "asset",
      scopeId: t.store.id,
      grantedBy: asUserId(t.admin.id)
    });
    try {
      await work();
    } finally {
      await t.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    }
  }

  /** Publishes a further App from files and answers the revision it was written as. */
  async function publishApp(name: string, parts: Parameters<typeof findingsApp>[0]) {
    const written = await t.putApp(t.admin.id, name, findingsApp({ id: name, ...parts }));
    expectStatus(written, 200);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    expectStatus(await t.publish(t.admin.id, name, revision), 200);
  }

  it("answers typed rows to a member who may use the App and holds no right on the store, filtered and paged by the declared parameters", async () => {
    const first = await rowsOf(t.kai.id, "list_findings", {
      client: "client-a",
      severity: "warning",
      limit: 1,
      offset: 0
    });

    expect(first.columns).toEqual([
      { name: "client_id", type: "text", nativeType: "text" },
      { name: "rule_id", type: "text", nativeType: "text" },
      { name: "revision", type: "integer", nativeType: "integer" },
      { name: "severity", type: "text", nativeType: "text" },
      { name: "amount", type: "number", nativeType: "numeric" },
      { name: "details", type: "other", nativeType: "jsonb" }
    ]);
    expect(first.rows).toEqual([
      {
        client_id: "client-a",
        rule_id: "vat-rate",
        revision: 3,
        severity: "warning",
        amount: "20.00",
        details: { booking: 2 }
      }
    ]);
    expect(first.truncated).toBe(false);
    const second = await rowsOf(t.kai.id, "list_findings", {
      client: "client-a",
      severity: "warning",
      limit: 1,
      offset: 1
    });
    expect(second.rows.map((row) => row.amount)).toEqual(["30.00"]);
    // A parameter that is left out does not narrow.
    const all = await rowsOf(t.kai.id, "list_findings", { limit: 4, offset: 0 });
    expect(all.rows.map((row) => row.client_id)).toEqual([
      "client-a",
      "client-a",
      "client-a",
      "client-b"
    ]);

    // One call, one run: the action's, by the viewer, with the origin the server made of the
    // frame, naming the store it read.
    const run = await t.runOf(first.runId);
    expect(run).toMatchObject({
      operation: "app.findings.list_findings",
      effect: "reading",
      status: "done",
      actor: { kind: "user", id: t.kai.id },
      workspaceId: t.workspaceId,
      origin: {
        kind: "app",
        appName: "findings",
        actionName: "list_findings",
        pageSessionId: first.frame.pageSessionId,
        target: { dataStore: "findings" }
      }
    });
    expect(await t.can(t.kai.id, first.frame)).toMatchObject({
      list_findings: "allow",
      add_finding: "confirm"
    });
  });

  it("gives the member nothing on the store itself: its own operations ask the right of whoever calls them, whatever origin the call names", async () => {
    const forged = {
      kind: "app" as const,
      appName: "findings",
      appRevisionId: "cfgr_forged",
      actionName: "list_findings",
      pageSessionId: "page_forged",
      target: { dataStore: "findings" }
    };
    for (const origin of [undefined, forged]) {
      const read = await t.invoke(
        t.kai,
        "data_store.findings.query",
        { sql: "select client_id from findings" },
        origin ? { origin } : {}
      );
      expect(read.result).toMatchObject({
        status: "denied",
        reason: { kind: "forbidden", action: "data_store.read" }
      });
      const added = await t.invoke(
        t.kai,
        "data_store.findings.insert",
        { table: "findings", rows: [finding(8)] },
        {
          effect: "changing",
          idempotencyKey: `b3-direct-${origin ? "forged" : "own"}`,
          ...(origin ? { origin } : {})
        }
      );
      expect(added.result).toMatchObject({
        status: "denied",
        reason: { kind: "forbidden", action: "data_store.insert" }
      });
    }
  });

  it("adds a row through a changing action for a member who holds no right on the store, as that person's own confirmed act, and never in a draft", async () => {
    const input = {
      run: "run-7",
      client: "client-new",
      rule: "vat-rate",
      revision: 2,
      severity: "error",
      amount: 12.5
    };
    const frame = await t.openApp(t.kai.id, "published", "findings");

    const response = await t.callAction(t.kai.id, frame, "add_finding", input, {
      "idempotency-key": "b3-insert-1"
    });

    // The instance asks for a confirmation of a change, and the person's own click is one.
    expectStatus(response, 200);
    const answer = resultSchema.parse(response.json());
    expect(answer).toMatchObject({
      status: "done",
      result: { table: "findings", inserted: 1, skipped: 0 }
    });
    expect(await t.runOf(answer.runId)).toMatchObject({
      operation: "app.findings.add_finding",
      effect: "changing",
      status: "done",
      actor: { kind: "user", id: t.kai.id },
      origin: { kind: "app", target: { dataStore: "findings" } }
    });
    // The same key again answers the first answer and adds nothing.
    const again = await t.callAction(t.kai.id, frame, "add_finding", input, {
      "idempotency-key": "b3-insert-1"
    });
    expect(resultSchema.parse(again.json()).runId).toBe(answer.runId);
    expect((await t.findingRows()).filter((row) => row.client_id === "client-new")).toMatchObject([
      { run_id: "run-7", severity: "error", amount: "12.50", revision: 2 }
    ]);
    // A draft runs in safe mode: the change is simulated and not carried out, whoever asks.
    const draft = await t.openApp(t.admin.id, "draft", "findings");
    const inDraft = await t.callAction(t.admin.id, draft, "add_finding", input, {
      "idempotency-key": "b3-insert-draft"
    });
    expectStatus(inDraft, 200);
    expect(inDraft.json()).toMatchObject({ status: "dry_run" });
    expect(await t.runOf(inDraft.headers["operation-run-id"])).toMatchObject({
      target: "dry_run"
    });
    expect((await t.findingRows()).filter((row) => row.client_id === "client-new")).toHaveLength(1);
  });

  it("asks the publisher of an App for the right on the store its actions use, and a writer of a draft for their own", async () => {
    // `pia` builds and publishes Apps by her role, which gives the rights on stores too: she
    // is denied them on this store, first both and then one.
    const pia = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Pia",
      roles: ["user", "admin"],
      permissions: []
    });
    const written = await t.putApp(
      t.admin.id,
      "findings-published-by",
      findingsApp({ id: "findings-published-by", marker: "publisher" })
    );
    expectStatus(written, 200);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    const publish = () => t.publish(pia.id, "findings-published-by", revision);
    const readInDraft = async () => {
      const draft = await t.openApp(pia.id, "draft", "findings-published-by");
      return t.callAction(pia.id, draft, "list_findings", { limit: 1, offset: 0 });
    };

    await withStoreRight(
      pia.id,
      "data_store.read",
      async () => {
        // The App has an action that adds and one that reads: each asks its own right.
        await withStoreRight(
          pia.id,
          "data_store.insert",
          async () => {
            const neither = await publish();
            expect(neither.statusCode).toBe(403);
            expect(t.refusal(neither).details).toMatchObject({ action: "data_store.insert" });
          },
          "deny"
        );
        const half = await publish();
        expect(half.statusCode).toBe(403);
        expect(t.refusal(half).details).toMatchObject({ action: "data_store.read" });
        // A draft was never published: who writes it reads with a right of their own.
        const inDraft = await readInDraft();
        expect(inDraft.statusCode).toBe(403);
        expect(t.refusal(inDraft).details).toMatchObject({ action: "data_store.read" });
      },
      "deny"
    );
    expectStatus(await readInDraft(), 200);
    expectStatus(await publish(), 200);
    // What the publisher answered for holds for a member who holds nothing on the store.
    const shown = await rowsOf(
      t.kai.id,
      "list_findings",
      { limit: 1, offset: 0 },
      "findings-published-by"
    );
    expect(shown.rows).toHaveLength(1);
  });

  it("holds an insert of an action to the size limit of the store", async () => {
    const full = await t.publishStore(
      "full",
      [{ ...manifest(), text: "id: full\nname: Full\n" }, init],
      t.workspaceId
    );
    await publishApp("findings-full", { marker: "full", store: "full" });
    await t.setSizeLimit(full.id, 1024 ** 2);
    const frame = await t.openApp(t.admin.id, "published", "findings-full");

    const response = await t.callAction(
      t.admin.id,
      frame,
      "add_finding",
      { run: "run-1", client: "client-a", rule: "vat-rate", revision: 1, severity: "info" },
      { "idempotency-key": "b3-insert-full" }
    );

    expect(response.statusCode).toBe(409);
    expect(t.refusal(response)).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("its size limit is 1048576 bytes (sizeLimit)"),
      details: { reason: "data_store_size_limit", limit: 1024 ** 2 }
    });
    // Reading keeps working.
    const read = await t.callAction(t.admin.id, frame, "list_findings", { limit: 1, offset: 0 });
    expectStatus(read, 200);
    expect(rowsSchema.parse(resultSchema.parse(read.json()).result).rows).toEqual([]);
  });

  it("binds a value and never writes it into the statement: SQL in a value reads nothing more and breaks nothing", async () => {
    const stored = await t.findingRows();
    for (const client of [
      "client-a' or '1'='1",
      "'; drop table findings; --",
      "client-a\\' or true --",
      "$1"
    ]) {
      const answer = await rowsOf(t.admin.id, "list_findings", { client, limit: 10, offset: 0 });
      expect(answer.rows, client).toEqual([]);
    }
    expect(await t.findingRows()).toEqual(stored);
    // A value that is no number is refused before a run exists, with nothing of a database.
    const frame = await t.openApp(t.admin.id, "published", "findings");
    const refused = await t.callAction(t.admin.id, frame, "list_findings", {
      limit: "1; select pg_sleep(1)",
      offset: 0
    });
    expect(refused.statusCode).toBe(422);
    expect(t.refusal(refused)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { reason: "input_invalid" }
    });
    expect(refused.body).not.toMatch(/syntax|postgres|sqlstate|catalyst_ds_/iu);
  });

  it("refuses a statement that writes: the read-only transaction rejects it, the run fails and no row changes", async () => {
    await publishApp("findings-writing", {
      marker: "writing",
      statements: {
        // What a screening of the text lets through, the transaction refuses.
        take_number:
          "select nextval(pg_get_serial_sequence('findings', 'id')) as taken from findings limit 1",
        remove_all: "with gone as (delete from findings returning 1) select count(*) from gone"
      }
    });
    const before = await t.findingRows();
    const frame = await t.openApp(t.admin.id, "published", "findings-writing");

    const taken = await t.callAction(t.admin.id, frame, "take_number", {});
    const removed = await t.callAction(t.admin.id, frame, "remove_all", {});

    expect(taken.statusCode).toBe(422);
    expect(t.refusal(taken)).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "The query tried to change data. Queries run in a read-only transaction."
    });
    expect(removed.statusCode).toBe(422);
    expect(t.refusal(removed).message).toBe(
      "Queries must not contain write, DDL, transaction, or session-control SQL"
    );
    expect(await t.findingRows()).toEqual(before);
    const run = await t.runOf(taken.headers["operation-run-id"]);
    expect(run).toMatchObject({
      operation: "app.findings-writing.take_number",
      status: "failed",
      error: { code: "VALIDATION_FAILED" }
    });
    const { audit } = await kept();
    expect(
      audit
        .filter((event) => event.metadata?.operationRunId === run.id)
        .map((event) => event.type)
        .sort()
    ).toEqual(["operation.authorization_checked", "operation.failed", "operation.started"]);
  });

  it("cuts a statement at the statement timeout and reports a timeout, and cuts a result at the row cap and says so", async () => {
    await publishApp("findings-limits", {
      marker: "limits",
      statements: {
        // An unbounded cross join: it ends when it is cancelled.
        runaway:
          "select count(*) from generate_series(1, 100000000) a cross join generate_series(1, 100000) b"
      }
    });
    const frame = await t.openApp(t.admin.id, "published", "findings-limits");

    t.statementLimits.statementTimeoutMs = 200;
    const late = await t.callAction(t.admin.id, frame, "runaway", {}).finally(() => {
      delete t.statementLimits.statementTimeoutMs;
    });
    expect(late.statusCode).toBe(504);
    expect(t.refusal(late)).toMatchObject({
      code: "TIMEOUT",
      message: "The query ran longer than the time limit and was cancelled."
    });
    expect(await t.runOf(late.headers["operation-run-id"])).toMatchObject({
      status: "failed",
      error: { code: "TIMEOUT" }
    });

    t.statementLimits.maxRows = 2;
    const cut = await rowsOf(t.admin.id, "list_findings", { limit: 10, offset: 0 }).finally(() => {
      delete t.statementLimits.maxRows;
    });
    expect([cut.rows.length, cut.truncated]).toEqual([2, true]);
    // Paging is the way to the rest: the declared parameters reach every row.
    const rest = await rowsOf(t.admin.id, "list_findings", { limit: 2, offset: 2 });
    expect([rest.rows.length, rest.truncated]).toEqual([2, false]);
  });

  it("refuses a person outside the App's workspace for the right on the App, before a right on the store is asked", async () => {
    const preview = await t.call(t.lena.id, "apps.preview", {
      params: { app: "findings" },
      payload: { mode: "published" }
    });
    expect(preview.statusCode).toBe(403);
    expect(t.refusal(preview).details).toMatchObject({ action: "app.use" });

    // Holding the right on the store opens no App: the right on the App is asked first.
    await withStoreRight(t.lena.id, "data_store.read", async () => {
      const refused = await t.invoke(t.lena, "app.findings.list_findings", { limit: 4, offset: 0 });
      expect(refused.result).toMatchObject({
        status: "denied",
        reason: { kind: "forbidden", action: "app.use" }
      });
    });
  });

  it("refuses the statement where the module dataStores is off, and keeps the App's other actions working", async () => {
    const frame = await t.openApp(t.admin.id, "published", "findings");
    {
      t.setDataStoresModule(false);
      try {
        const refused = await t.callAction(t.admin.id, frame, "list_findings", {
          limit: 10,
          offset: 0
        });
        expect(refused.statusCode).toBe(404);
        expect(t.refusal(refused)).toMatchObject({
          code: "NOT_FOUND",
          details: { reason: "module_off", module: "dataStores" }
        });
        expect(await t.runOf(refused.headers["operation-run-id"])).toMatchObject({
          status: "failed",
          error: { code: "NOT_FOUND" }
        });
        expect(await t.can(t.admin.id, frame)).toMatchObject({ list_findings: "deny" });

        const other = await t.callAction(t.admin.id, frame, "load", { text: "still here" });
        expectStatus(other, 200);
        expect(resultSchema.parse(other.json()).result).toEqual({ text: "still here" });
      } finally {
        t.setDataStoresModule(true);
      }
    }
  });

  it("runs in each frame the statement of its own revision, and refuses to publish an App below the level it needs", async () => {
    await publishApp("findings-revisions", {
      marker: "published",
      statements: { which: "select 'published' as revision from findings limit 1" }
    });
    const draft = await t.putApp(
      t.admin.id,
      "findings-revisions",
      findingsApp({
        id: "findings-revisions",
        marker: "draft",
        minSchema: 2,
        statements: { which: "select 'draft' as revision from findings limit 1" }
      })
    );
    expectStatus(draft, 200);
    const { revision } = z.object({ revision: z.number() }).parse(draft.json());

    const shown = await rowsOf(t.admin.id, "which", {}, "findings-revisions");
    expect(shown.rows).toEqual([{ revision: "published" }]);
    // A reading action runs live in the draft, for who writes the App.
    const draftFrame = await t.openApp(t.admin.id, "draft", "findings-revisions");
    const inDraft = await t.callAction(t.admin.id, draftFrame, "which", {});
    expectStatus(inDraft, 200);
    expect(rowsSchema.parse(resultSchema.parse(inDraft.json()).result).rows).toEqual([
      { revision: "draft" }
    ]);

    // The store is at level 1 and the draft asks for 2.
    const refused = await t.publish(t.admin.id, "findings-revisions", revision);
    expect(refused.statusCode).toBe(409);
    expect(t.refusal(refused)).toMatchObject({
      code: "CONFLICT",
      message:
        "The App needs the Data Store 'findings' at migration level 2 (minSchema) and the store is at level 1. Publish the App: its Publish carries the store's pending migrations (dataStores in assets.publish).",
      details: {
        reason: "data_store_below_min_schema",
        dataStore: "findings",
        minSchema: 2,
        level: 1
      }
    });
    expect((await rowsOf(t.admin.id, "which", {}, "findings-revisions")).rows).toEqual([
      { revision: "published" }
    ]);
  });

  it("refuses an App a store that is not there for it: one that does not exist, and one of another workspace", async () => {
    const unknown = await t.putApp(
      t.admin.id,
      "findings-unknown",
      findingsApp({ id: "findings-unknown", marker: "unknown", store: "ledger" })
    );
    expect(unknown.statusCode).toBe(422);
    expect(unknown.body).toContain(
      "The manifest names the Data Store 'ledger', which does not exist on this instance"
    );

    const elsewhere = await t.sharedWorkspace("Elsewhere");
    await t.publishStore(
      "elsewhere",
      [{ ...manifest(), text: "id: elsewhere\nname: Elsewhere\n" }, init],
      elsewhere
    );
    const written = await t.putApp(
      t.admin.id,
      "findings-elsewhere",
      findingsApp({ id: "findings-elsewhere", marker: "elsewhere", store: "elsewhere" })
    );
    expectStatus(written, 422);
    expect(t.refusal(written)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        reason: "invalid_scope",
        reference: {
          kind: "data_store",
          name: "elsewhere",
          owner: { kind: "workspace", workspaceId: elsewhere }
        }
      }
    });
    // The refused draft is never stored or made available to a frame.
    expect(
      await t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "app",
        name: "findings-elsewhere"
      })
    ).toBeUndefined();
  });

  it("reads no store from a Page of a conversation: nobody was given the use of a Page, so nothing stands for the right on the store", async () => {
    const page = await t.openPage(t.admin.id, findingsApp({ id: "findings-page", marker: "page" }));

    const response = await t.callAction(t.admin.id, page, "list_findings", {
      limit: 10,
      offset: 0
    });

    expect(response.statusCode).toBe(409);
    expect(t.refusal(response)).toMatchObject({
      code: "CONFLICT",
      details: { reason: "data_store_needs_app", dataStore: "findings" }
    });
    expect(await t.runOf(response.headers["operation-run-id"])).toMatchObject({
      operation: `page_action.${page.pageId}.list_findings`,
      status: "failed"
    });
    expect(await t.can(t.admin.id, page)).toMatchObject({ list_findings: "deny" });
  });

  it("reaches no store the manifest does not list, whatever a build answered: not at a publish and not at a call", async () => {
    const written = await t.putApp(
      t.admin.id,
      UNLISTED_STORE_APP,
      findingsApp({ id: UNLISTED_STORE_APP, marker: "unlisted" })
    );
    expectStatus(written, 200);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    const unlisted = {
      code: "VALIDATION_FAILED",
      message:
        "The action 'add_finding' reaches the Data Store 'findings', which the manifest of its App does not list under 'dataStores'. Add the store to dataStores in the App's manifest, save the App with app.save, and publish it with assets.publish.",
      details: { reason: "data_store_not_listed", dataStore: "findings" }
    };

    // The administrator holds every right on the store: the refusal is for the manifest.
    const published = await t.publish(t.admin.id, UNLISTED_STORE_APP, revision);
    expect(published.statusCode).toBe(422);
    expect(t.refusal(published)).toMatchObject(unlisted);
    const frame = await t.openApp(t.admin.id, "draft", UNLISTED_STORE_APP);
    const call = await t.callAction(t.admin.id, frame, "list_findings", { limit: 1, offset: 0 });
    expect(call.statusCode).toBe(422);
    expect(t.refusal(call).details).toMatchObject({ reason: "data_store_not_listed" });
    expect(await t.can(t.admin.id, frame)).toMatchObject({ list_findings: "deny" });
  });

  it("binds a parameter that was left out as no value, a list among them", async () => {
    await publishApp("findings-lists", {
      marker: "lists",
      statements: {
        of_clients: [
          "-- @param clients text[] optional",
          "-- @param revisions integer[] optional",
          "-- @param since date optional",
          "select client_id from findings",
          "where ($clients is null or client_id = any($clients))",
          "  and ($revisions is null or revision = any($revisions))",
          "  and ($since is null or $since <= current_date)",
          "order by id limit 4"
        ].join("\n")
      }
    });

    const all = await rowsOf(t.kai.id, "of_clients", {}, "findings-lists");
    const some = await rowsOf(
      t.kai.id,
      "of_clients",
      { clients: ["client-b"], revisions: [3] },
      "findings-lists"
    );

    expect(all.rows).toHaveLength(4);
    expect(some.rows).toEqual([{ client_id: "client-b" }]);
  });

  it("fails a call with a named reason once the store definition is gone", async () => {
    await t.publishStore(
      "archive",
      [{ ...manifest(), text: "id: archive\nname: Archive\n" }, init],
      t.workspaceId
    );
    await publishApp("findings-archive", { marker: "archive", store: "archive" });
    expect(
      (await rowsOf(t.admin.id, "list_findings", { limit: 1, offset: 0 }, "findings-archive")).rows
    ).toEqual([]);
    const frame = await t.openApp(t.admin.id, "published", "findings-archive");

    await t.removeStoreDefinition("archive");
    const response = await t.callAction(t.admin.id, frame, "list_findings", {
      limit: 1,
      offset: 0
    });

    expect(response.statusCode).toBe(404);
    expect(t.refusal(response)).toMatchObject({
      code: "NOT_FOUND",
      message:
        "The Data Store 'archive' is not available: no published Data Store of that name is in the App's workspace or on the instance. It may have been deleted. Save the Data Store with assets.put in a scope the App can reach, then publish it with assets.publish.",
      details: { reason: "data_store_unavailable", dataStore: "archive" }
    });
    expect(await t.runOf(response.headers["operation-run-id"])).toMatchObject({
      status: "failed",
      error: { code: "NOT_FOUND", reason: "data_store_unavailable" }
    });
    expect(await t.can(t.admin.id, frame)).toMatchObject({ list_findings: "deny" });
  });

  it("keeps no statement, no value and no row in a run or an audit event", async () => {
    await t.addFindings([finding(9, { client_id: "b3-row-marker", severity: "info" })]);
    await publishApp("findings-kept", {
      marker: "kept",
      statements: {
        marked:
          "-- @param client text\nselect client_id, 'b3-statement-marker' as marked from findings where client_id = $client"
      }
    });

    const answer = await rowsOf(t.admin.id, "marked", { client: "b3-row-marker" }, "findings-kept");
    expect(answer.rows).toEqual([{ client_id: "b3-row-marker", marked: "b3-statement-marker" }]);
    const frame = await t.openApp(t.admin.id, "published", "findings-kept");
    // A call that fails keeps as little: here one whose value fits no row and one that is refused.
    await t.callAction(t.admin.id, frame, "marked", { client: "b3-value-marker" });
    await t.callAction(t.admin.id, frame, "marked", { client: 7, further: "b3-value-marker" });

    const text = JSON.stringify(await kept());
    expect(text).toContain("app.findings-kept.marked");
    for (const marker of ["b3-row-marker", "b3-statement-marker", "b3-value-marker", "select "]) {
      expect(text, marker).not.toContain(marker);
    }
  });

  it("describes the published statement to an agent as a tool and runs the agent's call as the person in its chat", async () => {
    const tools = createAppActionToolSource({
      clientInstanceId,
      store: t.stores.configAssets,
      modules: { isEnabled: () => true },
      targetTools: combineDataToolSources(
        createConnectionToolSource(t.sourceDeps),
        t.dataStores.toolSource
      )
    });

    const [tool] = await tools.describe(["app.findings.list_findings"], {});

    expect(tool).toEqual({
      name: "app.findings.list_findings",
      description: expect.stringContaining("Reads rows of the Data Store 'findings'"),
      inputJsonSchema: {
        type: "object",
        properties: {
          client: { type: "string" },
          severity: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" }
        },
        required: ["limit", "offset"]
      },
      effect: "reading",
      revisionId: expect.stringMatching(/^cfgr_/)
    });
    expect(tool?.description).toContain("client, severity, limit, offset");
    expect(tool?.description).toContain('"truncated"');

    t.state.agentTools.set("assistant", ["app.findings.list_findings"]);
    const called = await t.invoke(
      t.admin,
      "app.findings.list_findings",
      { client: "client-b", limit: 5, offset: 0 },
      { origin: agentOrigin("app.findings.list_findings") }
    );
    expect(called.result).toMatchObject({
      status: "done",
      output: { rows: [expect.objectContaining({ client_id: "client-b" })], truncated: false }
    });
    expect(called.run).toMatchObject({
      actor: { kind: "user", id: t.admin.id },
      origin: { kind: "agent", toolName: "app.findings.list_findings" }
    });
    // A person outside the App's workspace is refused the same tool.
    const refused = await t.invoke(
      t.lena,
      "app.findings.list_findings",
      { limit: 5, offset: 0 },
      { origin: agentOrigin("app.findings.list_findings") }
    );
    expect(refused.result).toMatchObject({
      status: "denied",
      reason: { kind: "forbidden", action: "app.use" }
    });
  });
});
