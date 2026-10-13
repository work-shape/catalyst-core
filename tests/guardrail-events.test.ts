import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StoreBackedAuditRecorder,
  asClientInstanceId,
  dataStoreOperationName,
  type GuardrailEvent,
  type PlatformEventEmitter
} from "@vivd-catalyst/core";
import { GuardrailRunner, createAuditingEventEmitter } from "@vivd-catalyst/chat-server";
import {
  compileGuardrailPattern,
  parseClientInstanceConfig,
  type ClientInstanceConfig,
  type ReleaseGuardrailConfig
} from "@vivd-catalyst/config-schema";
import type { ModelCompletion } from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { createTestConfig } from "./support/fixtures";
import {
  createScriptedInstanceModelGateway,
  type FakeModelProvider as ModelProvider
} from "./support/model-gateway";
import { createTestInstance, type TestInstance } from "./support/test-instance";
import { setupNamespaceHolder } from "./support/asset-operations";
import { clientInstanceId as accessInstanceId, skill } from "./support/access-instance";
import { appFiles, setupAppInstance } from "./support/app-instance";
import {
  clientInstanceId as storeInstanceId,
  finding,
  useDataStoreInstance
} from "./support/data-store-instance";
import { OPERATION_CALL_APPROVAL_KIND, runOperation } from "@vivd-catalyst/tool-execution";

// The guardrails of release config at every before-event of a call: what a pattern and a judge
// answer and in which order, how the strictest answer wins, what a hit names, and what a person
// who saves an asset, publishes an App or calls an operation is told.

type TestStore = TestInstance["stores"];

const IBAN = "DE89 3704 0044 0532 0130 00";
const ibanPattern = "(?i)\\bDE\\d{2}(?:\\s?\\d{4}){4}\\s?\\d{2}\\b";
const judgeBinding = {
  id: "guardrailCheck",
  providerId: "local",
  model: "cheap-check",
  agentSelectable: false
};

function noIban(overrides: Partial<ReleaseGuardrailConfig> = {}): ReleaseGuardrailConfig {
  return {
    displayName: "No IBAN in skills",
    on: "asset.before_write",
    filter: { kind: "skill" },
    check: { kind: "pattern", pattern: ibanPattern, reason: "Skills hold no bank account." },
    outcome: "block",
    ...overrides
  };
}

function judge(
  on: GuardrailEvent,
  outcome: ReleaseGuardrailConfig["outcome"]
): ReleaseGuardrailConfig {
  return {
    on,
    check: { kind: "model_judge", modelBindingId: judgeBinding.id, instruction: "Datenschutz." },
    outcome
  };
}

function configWith(guardrails: Record<string, unknown>): ClientInstanceConfig {
  return parseClientInstanceConfig({
    ...createTestConfig({ modelBindings: [judgeBinding] }),
    guardrails
  });
}

function completion(text: string): ModelCompletion {
  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      source: "provider_reported",
      webSearchCallCount: 0
    }
  };
}

/** The guardrails of these release entries, with a judge that answers `violates`. */
function runnerOf(
  stores: TestStore,
  clientInstanceId: ReturnType<typeof asClientInstanceId>,
  guardrails: Record<string, unknown>
) {
  const config = configWith(guardrails);
  const complete = vi
    .fn<ModelProvider["complete"]>()
    .mockResolvedValue(completion('{"violates":true,"reason":"Names a person."}'));
  const runner = new GuardrailRunner({
    clientInstanceId,
    config,
    hits: stores.guardrails,
    modelGateway: createScriptedInstanceModelGateway({
      config,
      modelProvider: { complete },
      usageGovernance: new ModelUsageGovernance({
        store: stores.usage,
        budget: {},
        safeguards: {}
      })
    })
  });
  return { runner, complete };
}

/** The events of an instance whose release config holds these guardrails. */
function guardedEvents(stores: TestStore, guardrails: Record<string, unknown>) {
  const { runner, complete } = runnerOf(stores, accessInstanceId, guardrails);
  const events: PlatformEventEmitter = createAuditingEventEmitter(
    new StoreBackedAuditRecorder({ clientInstanceId: accessInstanceId, store: stores.audit }),
    runner
  );
  return { events, complete };
}

const runnerInstance = asClientInstanceId("guardrail-events");
const context = { correlationId: "corr_guardrail" };

describe("the guardrails at one before-event", () => {
  afterEach(() => vi.useRealTimers());

  async function fixture(guardrails: Record<string, unknown>) {
    const { stores } = await createTestInstance();
    return { stores, ...runnerOf(stores, runnerInstance, guardrails) };
  }
  const write = (content: string, kind = "skill") => ({
    event: "asset.before_write" as const,
    subject: { kind, name: "kunden-faq" },
    match: { kind, origin: "cli" },
    fields: () => ({ name: "kunden-faq", content })
  });
  const hits = (stores: TestStore, guardrailName: string) =>
    stores.guardrails.listHits({ clientInstanceId: runnerInstance, guardrailName, limit: 10 });

  // Fails without the change: release config knew no check but a model's.
  it("blocks on a pattern, names the subject in its hit, and keeps neither the content nor a person", async () => {
    const f = await fixture({ no_iban: noIban() });
    expect(await f.runner.answer(write(`Konto: ${IBAN}`), context)).toEqual([
      {
        guardrailName: "no_iban",
        displayName: "No IBAN in skills",
        outcome: "block",
        reason: "Skills hold no bank account.",
        origin: "release"
      }
    ]);
    expect(await f.runner.answer(write("Kein Konto."), context)).toEqual([
      expect.objectContaining({ guardrailName: "no_iban", outcome: "allow", reason: "" })
    ]);
    const [hit, ...more] = await hits(f.stores, "no_iban");
    expect(more).toEqual([]);
    expect(hit).toMatchObject({
      event: "asset.before_write",
      outcome: "block",
      subjectKind: "skill",
      subjectName: "kunden-faq"
    });
    expect(JSON.stringify(hit)).not.toContain("3704");
  });

  // Fails without the change: a judge ran beside a pattern that had already blocked.
  it("runs the patterns first, and a block among them skips the judges", async () => {
    const f = await fixture({ no_iban: noIban(), privacy: judge("asset.before_write", "warn") });
    const blocked = await f.runner.answer(write(`Konto: ${IBAN}`), context);
    expect(blocked.map((answer) => [answer.guardrailName, answer.outcome])).toEqual([
      ["no_iban", "block"]
    ]);
    expect(f.complete).not.toHaveBeenCalled();
    expect(await hits(f.stores, "privacy")).toEqual([]);

    const judged = await f.runner.answer(write("Herr Müller ruft an."), context);
    expect(judged.map((answer) => [answer.guardrailName, answer.outcome])).toEqual([
      ["no_iban", "allow"],
      ["privacy", "warn"]
    ]);
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("applies a filter by kind, operation, origin and agent, and an operation prefix", async () => {
    const f = await fixture({
      skills_only: noIban(),
      inserts: {
        on: "operation.before_call",
        filter: { operation: "data_store.*", origin: "agent", agent: "assistant" },
        check: { kind: "pattern", pattern: "." },
        outcome: "require_approval"
      }
    });
    expect(await f.runner.answer(write(IBAN, "agent"), context)).toEqual([]);
    const call = (match: Record<string, string>) =>
      f.runner.answer(
        {
          event: "operation.before_call",
          subject: { kind: "operation", name: "data_store.kunden.insert" },
          match: { operation: "data_store.kunden.insert", ...match },
          fields: () => ({ input: "{}" })
        },
        context
      );
    expect(await call({ origin: "agent", agent: "assistant" })).toEqual([
      expect.objectContaining({ guardrailName: "inserts", outcome: "require_approval" })
    ]);
    expect(await call({ origin: "agent", agent: "other" })).toEqual([]);
    expect(await call({ origin: "user" })).toEqual([]);
  });

  // Fails without the change: a field past the cap was matched in part, or not at all.
  it("refuses unread content where a guardrail blocks or holds, and warns unevaluated where it warns", async () => {
    const f = await fixture({
      blocking: noIban(),
      warning: noIban({ outcome: "warn" }),
      holding: judge("asset.before_write", "require_approval")
    });
    const answers = await f.runner.answer(write("x".repeat(2 * 1024 * 1024 + 1)), context);
    expect(answers.map((answer) => [answer.guardrailName, answer.outcome])).toEqual([
      ["blocking", "block"],
      ["warning", "warn"]
    ]);
    expect(answers[0]?.reason).toContain("could not read content longer than");
    expect(answers[1]?.reason).toBe("");
    // The block among the patterns skipped the judge, which holds.
    expect(f.complete).not.toHaveBeenCalled();
  });

  // Fails without the change: a pattern of a large program read 2 Mi characters and held the
  // server for seconds.
  it("reads less of a field the larger a pattern's program is", async () => {
    const pattern = `${ibanPattern}|[a-z]{300}[0-9]`;
    const { maxChars } = compileGuardrailPattern(pattern);
    expect(maxChars).toBeLessThan(2 * 1024 * 1024);
    const f = await fixture({
      blocking: noIban({ check: { kind: "pattern", pattern } }),
      warning: noIban({ check: { kind: "pattern", pattern }, outcome: "warn" })
    });
    expect(
      (await f.runner.answer(write("x".repeat(maxChars)), context)).map((a) => a.outcome)
    ).toEqual(["allow", "allow"]);
    const answers = await f.runner.answer(write("x".repeat(maxChars + 1)), context);
    expect(answers.map((answer) => [answer.guardrailName, answer.outcome])).toEqual([
      ["blocking", "block"],
      ["warning", "warn"]
    ]);
    expect(answers[0]?.reason).toContain(`could not read content longer than ${maxChars}`);
  });

  it("holds where a judge that holds cannot answer, and keeps no hit when asked again", async () => {
    const f = await fixture({ holding: judge("asset.before_write", "require_approval") });
    f.complete.mockRejectedValue(new Error("provider detail"));
    expect(await f.runner.answer(write("Text"), context)).toEqual([
      expect.objectContaining({
        outcome: "require_approval",
        reason: "Check 'holding' could not be evaluated. Try again later."
      })
    ]);
    await f.runner.answer(write("Text"), { ...context, repeated: true });
    expect(await hits(f.stores, "holding")).toHaveLength(1);
  });

  // EW-6a makes the kind writable. Until then every guardrail is the release floor, which runs
  // on a write of a guardrail as on any other.
  it("runs the release floor on a write of a guardrail", async () => {
    const f = await fixture({ floor: noIban({ filter: { kind: "guardrail" } }) });
    expect(await f.runner.answer(write(IBAN, "guardrail"), context)).toEqual([
      expect.objectContaining({ guardrailName: "floor", outcome: "block" })
    ]);
  });
  it.todo(
    "EW-6a: never runs a guardrail asset on a write, publish or delete of a guardrail; only the release floor"
  );
});

describe("guardrails in release config", () => {
  const refused = (guardrail: Record<string, unknown>) => () =>
    parseClientInstanceConfig({
      ...createTestConfig({ modelBindings: [judgeBinding] }),
      guardrails: { rule: guardrail }
    });

  // Fails without the change: a backtracking pattern would have been accepted and run.
  it.each(["(a)\\1", "(?=lookahead)"])(
    "refuses the pattern %s, which RE2 does not compile, and says why at load",
    (pattern) => {
      expect(refused({ ...noIban(), check: { kind: "pattern", pattern } })).toThrow(
        "The pattern is no RE2 expression, which has no backreferences and no lookaround"
      );
    }
  );

  it.each([
    ["a pattern past its limit", { check: { kind: "pattern", pattern: "a".repeat(2_001) } }],
    // Fails without the change: a short pattern of a large program was accepted and read little.
    [
      "a pattern too complex to read 64 Ki",
      { check: { kind: "pattern", pattern: "[a-z]{1000}[0-9]" } }
    ],
    ["a filter its event does not know", { filter: { operation: "data_store.*" } }],
    [
      "a field its event does not have",
      { check: { kind: "pattern", pattern: "x", fields: ["input"] } }
    ],
    [
      "an approval at an event where nothing waits",
      {
        on: "approval_request.before_create",
        filter: undefined,
        outcome: "require_approval"
      }
    ],
    ["an unknown origin", { on: "operation.before_call", filter: { origin: "browser" } }]
  ])("refuses %s", (_case, overrides) => {
    expect(refused({ ...noIban(), ...overrides })).toThrow("Client instance config is invalid");
  });

  it("loads a guardrail at each event the platform runs them at", () => {
    const config = configWith({
      writes: noIban(),
      calls: {
        on: "operation.before_call",
        filter: { operation: "data_store.kunden.insert" },
        check: { kind: "pattern", pattern: ".", fields: ["input"] },
        outcome: "require_approval"
      },
      apps: { ...noIban(), on: "app.before_publish", filter: { origin: "user" } },
      workflows: judge("workflow.before_publish", "allow")
    });
    expect(Object.keys(config.guardrails)).toEqual(["writes", "calls", "apps", "workflows"]);
  });
});

describe("a guardrail at a call of the asset operations", () => {
  // Fails without the change: `asset.before_write` was run by nothing, and the push wrote the
  // skill with the IBAN.
  it("refuses a Namespace holder's skill push with an IBAN, names the guardrail, the skill and the reason, and writes nothing", async () => {
    let complete: ReturnType<typeof vi.fn> | undefined;
    const t = await setupNamespaceHolder({
      server: (stores) => {
        const guarded = guardedEvents(stores, { no_iban: noIban() });
        complete = guarded.complete;
        return { operations: { events: guarded.events } };
      }
    });
    const pushed = await t.call(t.kai.id, "assets.sync", {
      payload: {
        namespace: "kai-",
        items: [
          {
            type: "put",
            kind: "skill",
            config: skill("kai-faq", `Überweise an ${IBAN}.`),
            expectedRevision: null
          }
        ]
      }
    });
    expect(pushed.statusCode).toBe(403);
    const { error } = pushed.json<{ error: { code: string; message: string; details: unknown } }>();
    expect(error).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      message:
        "Guardrail 'No IBAN in skills' blocked skill 'kai-faq': Skills hold no bank account.",
      details: { guardrailId: "no_iban" }
    });
    expect(await t.stored("skill", "kai-faq")).toBeUndefined();
    expect(complete).not.toHaveBeenCalled();
    // The refusal is audited as the call's denial; no row holds the skill's text.
    const audit = await t.stores.audit.listAuditEvents({ clientInstanceId: accessInstanceId });
    expect(audit.map((event) => event.type)).toContain("operation.denied");
    expect(JSON.stringify(audit)).not.toContain("3704");

    // The same push without the IBAN is written.
    const clean = await t.call(t.kai.id, "assets.sync", {
      payload: {
        namespace: "kai-",
        items: [
          {
            type: "put",
            kind: "skill",
            config: skill("kai-faq", "Überweisungen klärt die Buchhaltung."),
            expectedRevision: null
          }
        ]
      }
    });
    expect(clean.statusCode).toBe(200);
  });

  // Fails without the change: of two answers, the call took the first, an allow.
  it("blocks a push that a release-floor allow and a block both answer", async () => {
    const t = await setupNamespaceHolder({
      server: (stores) => ({
        operations: {
          events: guardedEvents(stores, {
            allowed: noIban({ displayName: "Allowed", outcome: "allow" }),
            blocked: noIban({ displayName: "Blocked" })
          }).events
        }
      })
    });
    const put = await t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "kunden-faq" },
      payload: { config: skill("kunden-faq", IBAN), expectedRevision: null }
    });
    expect(put.statusCode).toBe(403);
    expect(put.json<{ error: { details: unknown } }>().error.details).toEqual({
      guardrailId: "blocked"
    });
    expect(await t.stored("skill", "kunden-faq")).toBeUndefined();
  });

  // Fails without the change: a publish ran no guardrail of `app.before_publish`.
  it("refuses to publish an App whose files match, and lets its draft be saved", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({
        operations: {
          events: guardedEvents(stores, {
            no_iban_in_apps: noIban({
              displayName: "No IBAN in Apps",
              on: "app.before_publish",
              filter: undefined
            })
          }).events
        }
      })
    });
    const files = appFiles(`Konto ${IBAN}`);
    expect((await t.putApp(t.admin.id, "offers", files)).statusCode).toBe(200);
    const published = await t.publish(t.admin.id, "offers", 1);
    expect(published.statusCode).toBe(403);
    expect(published.json<{ error: { message: string } }>().error.message).toBe(
      "Guardrail 'No IBAN in Apps' blocked app 'offers': Skills hold no bank account."
    );
    expect((await t.listed("offers")).publishedRevision).toBeUndefined();
    const [hit] = await t.stores.guardrails.listHits({
      clientInstanceId: accessInstanceId,
      guardrailName: "no_iban_in_apps",
      limit: 1
    });
    expect(hit).toMatchObject({
      event: "app.before_publish",
      subjectKind: "app",
      subjectName: "offers"
    });
    expect(hit?.subjectId).toEqual(expect.any(String));
    await t.close();
  });
});

describe("a guardrail that asks for an approval", () => {
  const { start, publishStore, person } = useDataStoreInstance();

  // Fails without the change: `operation.before_call` answered `allow` whatever release config
  // held, and the row was inserted at once.
  it("holds an insert into a Data Store in the Inbox and inserts nothing yet", async () => {
    const operation = dataStoreOperationName("findings", "insert");
    const world = await start(true, undefined, undefined, {
      inserts_need_approval: {
        displayName: "Findings are approved",
        on: "operation.before_call",
        filter: { operation },
        check: { kind: "pattern", pattern: "." },
        outcome: "require_approval"
      }
    });
    await publishStore(world);
    const admin = await person(world, "user-1", ["user", "admin", "superadmin"]);
    const outcome = await runOperation(
      {
        operation,
        effect: "changing",
        input: { table: "findings", rows: [finding] },
        actor: admin,
        origin: { kind: "user" },
        correlationId: "corr_guarded_insert"
      },
      world.execution.operationCalls.deps
    );
    expect(outcome.result.status).toBe("pending_approval");
    const [request, ...more] = await world.stores.approvals.listApprovalRequests({
      clientInstanceId: storeInstanceId,
      kinds: [OPERATION_CALL_APPROVAL_KIND],
      status: "pending"
    });
    expect(more).toEqual([]);
    expect(request).toMatchObject({ kind: OPERATION_CALL_APPROVAL_KIND, status: "pending" });
    const [hit] = await world.stores.guardrails.listHits({
      clientInstanceId: storeInstanceId,
      guardrailName: "inserts_need_approval",
      limit: 5
    });
    expect(hit).toMatchObject({
      event: "operation.before_call",
      outcome: "require_approval",
      subjectKind: "operation",
      subjectName: operation
    });
    // The hit names the call, never its rows.
    expect(JSON.stringify(hit)).not.toContain("client-secret-7");
    const counted = await runOperation(
      {
        operation: dataStoreOperationName("findings", "query"),
        effect: "reading",
        input: { sql: "select count(*)::integer as count from findings" },
        actor: admin,
        origin: { kind: "user" },
        correlationId: "corr_guarded_count"
      },
      world.execution.operationCalls.deps
    );
    expect(counted.result).toMatchObject({ status: "done", output: { rows: [{ count: 0 }] } });
  });
});
