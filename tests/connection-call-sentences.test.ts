import { describe, expect, it } from "vitest";
import {
  AppError,
  CONNECTION_CALL_REASONS,
  CONNECTION_NAME_IN_SENTENCE_MAX_LENGTH,
  connectionCallError,
  connectionCallSentence,
  connectionUseDeniedSentence,
  operationDenialError,
  type ConnectionCallReason
} from "@vivd-catalyst/core";
import {
  ConnectionCallSlots,
  callConnectionOperation,
  readConnection
} from "@vivd-catalyst/connections";
import { DEFAULT_LIMITS, agentOrigin, fixture, operationOf } from "./support/connection-operations";

// What a failed call of a Connection operation tells its caller: a sentence for people that
// names the Connection, with the fixed reason beside it. Each test fails without the change:
// before it the message was "<reason>: <platform text>" and named no Connection.

const REASONS: ConnectionCallReason[] = [
  "connection_unavailable",
  "connection_not_configured",
  "secret_unreadable",
  "operation_unknown",
  "operation_disabled",
  "operation_needs_review",
  "egress_denied",
  "input_invalid",
  "output_invalid",
  "output_rejected",
  "upstream_unauthorized",
  "upstream_rate_limited",
  "upstream_timeout",
  "upstream_error",
  "upstream_conflict",
  "connection_busy",
  "schema_check_timeout",
  "schema_check_unavailable",
  "schema_too_large",
  "schema_too_deep",
  "schema_too_many_refs",
  "schema_too_many_patterns",
  "schema_pattern_too_long"
];

/** What a caller can do next, as each sentence has to say it. */
const NEXT_STEP = /[Tt]r(?:y|ying) again|Asking for less may work/u;

describe("the sentence of a reason", () => {
  it("exists for every reason the call path can end with", () => {
    expect([...REASONS].sort()).toEqual(Object.keys(CONNECTION_CALL_REASONS).sort());
  });

  it.each(REASONS)("%s names the Connection and says whether to try again", (reason) => {
    const sentence = connectionCallSentence(reason, "Sample business");

    expect(sentence).toMatch(/[Tt]he connection Sample business/u);
    expect(sentence).toMatch(NEXT_STEP);
    expect(sentence).toMatch(/^[A-Z].*\.$/u);
    // No code and no word of the machinery: the reader is a person.
    expect(sentence).not.toContain(reason);
    expect(sentence).not.toMatch(/_|egress|upstream|schema|slot|revision|:\d/u);
  });

  it("names no Connection where the call found none", () => {
    for (const name of [undefined, "", " \n "]) {
      expect(connectionCallSentence("connection_unavailable", name)).toMatch(
        /^This connection cannot be used right now\./u
      );
    }
  });

  it("repeats a display name as one bounded line", () => {
    const sentence = connectionCallSentence(
      "connection_busy",
      `Sample\nbusiness\u0000\u2028 ${"x".repeat(500)}`
    );

    expect(sentence).toContain("the connection Sample business x");
    expect(sentence).not.toMatch(/[\n\u0000\u2028]/u);
    expect(sentence.length).toBeLessThan(CONNECTION_NAME_IN_SENTENCE_MAX_LENGTH + 80);
  });
});

describe("a call of a Connection operation that fails", () => {
  it.each(REASONS)("ends as %s with its sentence, and the run keeps the reason", async (reason) => {
    const t = await fixture();
    const assetId = await t.seed("crm", { displayName: "Sample business" });
    await t.grant(t.kai.id, "connection.use", { assetId });
    // The text a Connector type composed never leaves, whatever the reason.
    t.setBehaviour(() =>
      Promise.reject(connectionCallError(reason, "sample-mcp:8787 said: token rejected"))
    );

    const failed = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));

    // The operation of the fixture reads, which the sentence of a timeout says.
    const sentence = connectionCallSentence(reason, "Sample business", "reading");
    expect(failed).toEqual({ code: CONNECTION_CALL_REASONS[reason], reason, message: sentence });
    const runs = await t.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "failed",
      error: { code: CONNECTION_CALL_REASONS[reason], reason, message: sentence }
    });
    expect(JSON.stringify(runs)).not.toContain("sample-mcp");
  });

  it("keeps a refused target out of the sentence", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", { displayName: "Sample business" });
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.hostAllowed = false;

    const failed = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));

    expect(failed).toMatchObject({
      reason: "egress_denied",
      message: connectionCallSentence("egress_denied", "Sample business")
    });
    expect(failed.message).not.toMatch(/example|\d{2,}/u);
  });

  // Fails without the change: the message named the host and the port that did not resolve.
  it("tells a listed host without an address as unavailable, with its cause in the details", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", { displayName: "Sample business" });
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.hostResolves = false;

    const outcome = await t.invoke(t.kai, "connection.crm.echo", { text: "a" });

    const sentence = connectionCallSentence("connection_unavailable", "Sample business");
    expect(outcome.result).toMatchObject({
      status: "failed",
      error: {
        code: "CONFLICT",
        message: sentence,
        details: { reason: "connection_unavailable", cause: "egress_unresolved", port: 443 }
      }
    });
    expect(outcome.run.error).toMatchObject({
      reason: "connection_unavailable",
      message: sentence
    });
    expect(sentence).not.toMatch(/\d|resolve/u);
  });

  // Fails without the fix: the result of a timeout carried no details, and a failure answered
  // again under its key carried the code and the sentence only.
  it("keeps the reason in the details of a timeout and of a failure answered again", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", {
      displayName: "Sample business",
      operations: [operationOf("echo"), operationOf("write", { effect: "changing" })]
    });
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.limits = { ...DEFAULT_LIMITS, callTimeoutMs: 150 };
    t.setBehaviour(() => new Promise(() => undefined));

    const late = await t.invoke(t.kai, "connection.crm.echo", { text: "a" });

    expect(late.result).toMatchObject({
      status: "failed",
      error: { code: "TIMEOUT", details: { reason: "upstream_timeout" } }
    });

    t.setBehaviour(() => Promise.reject(connectionCallError("upstream_error")));
    const keyed = { effect: "changing" as const, idempotencyKey: "key-again-1" };
    const first = await t.invoke(t.kai, "connection.crm.write", {}, keyed);
    const again = await t.invoke(t.kai, "connection.crm.write", {}, keyed);

    expect(first.result).toMatchObject({ status: "failed" });
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual({
      status: "failed",
      runId: first.run.id,
      error: {
        code: "CONFLICT",
        message: connectionCallSentence("upstream_error", "Sample business"),
        details: { reason: "upstream_error" }
      }
    });
  });

  // Fails without the fix: the display name was taken from whatever the name read, before the
  // asset and the revision of the call were compared.
  it("does not name a Connection the call was not authorized on", async () => {
    const t = await fixture();
    await t.seed("crm", { displayName: "Sample business" });
    const stored = await readConnection(t.sourceDeps, "crm");
    if (!stored) throw new Error("the Connection is stored");
    const refusedFor = async (target: { assetId: string; revision: number }) => {
      const error: unknown = await callConnectionOperation(
        t.sourceDeps,
        new ConnectionCallSlots(),
        { connectionName: "crm", operationName: "echo", ...target },
        { text: "a" },
        { runtime: {} }
      ).then(
        () => undefined,
        (thrown: unknown) => thrown
      );
      if (!(error instanceof AppError)) throw new Error("the call is refused");
      return error.message;
    };

    for (const target of [
      { assetId: "asset_of_before", revision: stored.revision },
      { assetId: stored.assetId, revision: stored.revision + 1 }
    ]) {
      const message = await refusedFor(target);
      expect(message).toBe(connectionCallSentence("connection_unavailable", undefined));
      expect(message).not.toContain("Sample business");
    }
    expect(t.executed).toEqual([]);
  });

  it("names no Connection for a call whose Connection changed since its checks", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", { displayName: "Sample business" });
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.beforeSecondRead = async () => {
      await t.seed("crm", { displayName: "Other business", enabled: false });
    };

    const failed = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));

    expect(failed).toMatchObject({
      reason: "connection_unavailable",
      message: connectionCallSentence("connection_unavailable", undefined)
    });
    expect(t.executed).toEqual([]);
  });
});

// What a real model made of three texts: a missing right read as an outage, a timed-out read
// came with a warning about a change, and a refused network path read as a switched-off
// Connection. Each test fails without the change.

/** Nothing of the machinery in a text a model words an answer from. */
const NO_CODE_OR_ADDRESS = /[a-z]_[a-z]|connection\.use|:\d|\d+\.\d+|https?:|egress|upstream/u;

describe("the three texts a model misread", () => {
  it("says a missing right as a refusal that an administrator lifts", () => {
    const sentence = connectionUseDeniedSentence("Sample business");

    expect(sentence).toBe(
      "The person making this request does not hold the right to use the connection Sample business. Nothing is wrong with the connection, and trying again will not help. An administrator can give the right under Settings > Instance > Access."
    );
    expect(sentence).not.toMatch(NO_CODE_OR_ADDRESS);
    expect(sentence).not.toMatch(/available|reached|right now|disabled/u);
    expect(connectionUseDeniedSentence(undefined)).toContain("the right to use this connection.");
  });

  it("says a timed-out read is safe to repeat and keeps the warning for a change", () => {
    const reading = connectionCallSentence("upstream_timeout", "Sample business", "reading");

    expect(reading).toBe(
      "The connection Sample business did not answer in time. This action only reads, so trying again is safe. If it keeps failing, an administrator can check it under Build > Connections."
    );
    expect(reading).not.toMatch(/chang/u);
    expect(reading).not.toMatch(NO_CODE_OR_ADDRESS);
    for (const effect of ["changing", undefined] as const) {
      const sentence = connectionCallSentence("upstream_timeout", "Sample business", effect);
      expect(sentence).toContain("it is not known whether the change happened");
      expect(sentence).not.toContain("safe");
    }
  });

  it("says a refused network path as a path to allow, not a Connection that is off", () => {
    const sentence = connectionCallSentence("egress_denied", "Sample business");

    expect(sentence).toBe(
      "The network path from this instance to the outside system of the connection Sample business has not been allowed yet. The connection itself is switched on. Trying again will not help until an administrator allows the path. The state is shown under Build > Connections."
    );
    expect(sentence).not.toMatch(/disabled|switched off|not available/u);
    expect(sentence).not.toMatch(NO_CODE_OR_ADDRESS);
  });
});

describe("a call by somebody without the right to use the Connection", () => {
  it("is denied with the sentence, which names the Connection to an agent's chat only", async () => {
    const t = await fixture();
    await t.seed("crm", { displayName: "Sample business" });
    // Only an agent that carries the tool reaches the check of the right at all.
    t.state.agentTools.set("assistant", ["connection.crm.echo"]);

    const byAgent = await t.invoke(
      t.kai,
      "connection.crm.echo",
      { text: "a" },
      { origin: agentOrigin("connection.crm.echo") }
    );
    const byPerson = await t.invoke(t.kai, "connection.crm.echo", { text: "a" });

    if (byAgent.result.status !== "denied" || byPerson.result.status !== "denied") {
      throw new Error("both calls are denied");
    }
    // The denial keeps the right and the reason beside the text.
    expect(byAgent.result.reason).toEqual({
      kind: "forbidden",
      action: "connection.use",
      reason: "no_grant",
      message: connectionUseDeniedSentence("Sample business")
    });
    // What the agent's tool call answers is the message of the denial.
    expect(operationDenialError(byAgent.result.reason).message).toBe(
      connectionUseDeniedSentence("Sample business")
    );
    expect(byPerson.result.reason).toMatchObject({
      action: "connection.use",
      message: connectionUseDeniedSentence(undefined)
    });
    expect(JSON.stringify(byPerson.result)).not.toContain("Sample business");
    expect(t.executed).toEqual([]);
    expect(await t.runs()).toMatchObject([{ status: "denied" }, { status: "denied" }]);
  });
});

describe("a call that timed out", () => {
  it("is told by the effect of its operation", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", {
      displayName: "Sample business",
      operations: [operationOf("echo"), operationOf("write", { effect: "changing" })]
    });
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.limits = { ...DEFAULT_LIMITS, callTimeoutMs: 150 };
    t.setBehaviour(() => new Promise(() => undefined));

    const read = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
    const changed = await t.failure(
      t.invoke(t.kai, "connection.crm.write", {}, { effect: "changing" })
    );

    expect(read.message).toBe(
      connectionCallSentence("upstream_timeout", "Sample business", "reading")
    );
    expect(changed.message).toBe(
      connectionCallSentence("upstream_timeout", "Sample business", "changing")
    );
    expect(changed.message).not.toBe(read.message);
  });
});
