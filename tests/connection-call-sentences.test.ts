import { describe, expect, it } from "vitest";
import {
  CONNECTION_CALL_REASONS,
  CONNECTION_NAME_IN_SENTENCE_MAX_LENGTH,
  connectionCallError,
  connectionCallSentence,
  type ConnectionCallReason
} from "@vivd-catalyst/core";
import { fixture } from "./support/connection-operations";

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
  "connection_busy"
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

    const sentence = connectionCallSentence(reason, "Sample business");
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

  it("names the Connection where the call is refused before anything is contacted", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", { displayName: "Sample business" });
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.beforeSecondRead = async () => {
      await t.seed("crm", { displayName: "Sample business", enabled: false });
    };

    const failed = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));

    expect(failed).toMatchObject({
      reason: "connection_unavailable",
      message: connectionCallSentence("connection_unavailable", "Sample business")
    });
    expect(t.executed).toEqual([]);
  });
});
