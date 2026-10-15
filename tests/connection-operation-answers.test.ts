import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectionDetailSchema, connectionToolsSchema } from "@work-shape/catalyst-api-contract";
import { AppError, connectionCallError, type JsonValue } from "@work-shape/catalyst-core";
import { agent, clientInstanceId } from "./support/access-instance";
import {
  DEFAULT_LIMITS,
  agentOrigin,
  echo,
  fixture,
  operationOf,
  write
} from "./support/connection-operations";
import {
  captureProcessOutput,
  dumpDatabaseText,
  findLeak,
  generateTestSecret
} from "./support/test-connector";
import { applyAtCurrentRevisions } from "./support/asset-revisions";

// What leaves a call of a Connection's operation and the Connection's routes: the result of
// the Connector type once it is bounded, searched for the credential and validated, a reason
// and no text of the outside system, and never the credential.
//
// Every test here fails without the change: before it no such operation resolved, the three
// routes did not exist, and nothing bounded, searched or validated what a type returned.

afterEach(() => {
  vi.restoreAllMocks();
});
describe("what a Connector type returns", () => {
  it("is discarded as output_rejected when it holds the credential in any encoding", async () => {
    const quoted = `tk_"quo\\ted"_${generateTestSecret()}`;
    const t = await fixture({ secret: quoted });
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });
    const bytes = Buffer.from(t.secret, "utf8");
    const echoes: Record<string, JsonValue> = {
      plain: { note: `Bearer ${t.secret}` },
      "as a JSON string": { token: t.secret },
      "JSON inside a string": { body: JSON.stringify({ token: t.secret }) },
      base64: { header: Buffer.from(`Bearer ${t.secret}`, "utf8").toString("base64") },
      "base64 at another offset": { header: Buffer.from(`x:${t.secret}!`).toString("base64") },
      base64url: { header: bytes.toString("base64url") },
      hex: { dump: bytes.toString("hex") },
      "percent-encoded": { url: `https://x.test/?t=${encodeURIComponent(t.secret)}` },
      "as a key": { [t.secret]: true }
    };

    const output = captureProcessOutput();
    let logged: string;
    try {
      for (const [form, result] of Object.entries(echoes)) {
        t.setBehaviour(() => Promise.resolve(result));
        const outcome = await t.invoke(t.kai, "connection.crm.echo", { text: form });
        const failed = await t.failure(Promise.resolve(outcome));
        expect(failed, form).toMatchObject({ code: "CONFLICT", reason: "output_rejected" });
        expect(findLeak(JSON.stringify(outcome), t.secret), form).toBeUndefined();
      }
    } finally {
      logged = output.stop();
    }
    // The connector ran each time: this is the one refusal after the outside system answered.
    expect(await t.runs()).toHaveLength(Object.keys(echoes).length);
    expect(findLeak(await dumpDatabaseText(), t.secret)).toBeUndefined();
    expect(findLeak(logged, t.secret)).toBeUndefined();
  });

  it("is refused as output_invalid when it is too large or does not fit the accepted schema", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });

    t.setBehaviour(() => Promise.resolve({ text: "x".repeat(DEFAULT_LIMITS.resultMaxBytes) }));
    const large = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
    expect(large).toMatchObject({ code: "CONFLICT", reason: "output_invalid" });

    t.setBehaviour(() => Promise.resolve("not an object"));
    const unfit = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
    expect(unfit.reason).toBe("output_invalid");
    expect(unfit.message).not.toContain("not an object");
  });

  // Fails without the change: serializing such a result threw a RangeError outside every
  // check, and the call ended as an internal error.
  it("is refused as output_invalid when it is nested too deeply to serialize", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });
    let deep: JsonValue = [];
    for (let level = 0; level < 200_000; level += 1) deep = [deep];

    t.setBehaviour(() => Promise.resolve({ deep }));
    const failed = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
    expect(failed).toMatchObject({ code: "CONFLICT", reason: "output_invalid" });
  });

  it("passes on a reason and never a text of the outside system or of the type", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });
    const marker = "upstream-body-4f1c9e";

    const output = captureProcessOutput();
    let logged: string;
    try {
      t.setBehaviour(() => Promise.reject(new Error(`500 from upstream: ${marker} ${t.secret}`)));
      const unknown = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
      expect(unknown).toMatchObject({ code: "INTERNAL" });
      expect(unknown.message).not.toContain(marker);

      t.setBehaviour(() =>
        Promise.reject(connectionCallError("upstream_unauthorized", `${marker} ${t.secret}`))
      );
      const unauthorized = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
      expect(unauthorized).toMatchObject({ code: "CONFLICT", reason: "upstream_unauthorized" });
      expect(unauthorized.message).not.toContain(marker);

      t.setBehaviour(() =>
        Promise.reject(new AppError("RATE_LIMITED", marker, { reason: "upstream_rate_limited" }))
      );
      const limited = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
      expect(limited).toMatchObject({ code: "RATE_LIMITED", reason: "upstream_rate_limited" });
      expect(limited.message).not.toContain(marker);
    } finally {
      logged = output.stop();
    }
    const stored = await dumpDatabaseText();
    expect(stored).not.toContain(marker);
    expect(logged).not.toContain(marker);
    expect(findLeak(stored, t.secret)).toBeUndefined();
    expect(findLeak(logged, t.secret)).toBeUndefined();
    // A refused credential says the Connection is broken. The rate limit does not.
    expect(await t.health(assetId)).toBe("failed");
  });

  it("is not waited for past the call's deadline", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.use", { assetId });
    t.state.limits = { ...DEFAULT_LIMITS, callTimeoutMs: 150 };
    let stopped = false;
    // A type that ignores its signal: the call ends all the same.
    t.setBehaviour((_operation, _input, context) => {
      context.signal.addEventListener("abort", () => (stopped = true), { once: true });
      return new Promise(() => undefined);
    });

    const failed = await t.failure(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));

    expect(failed).toMatchObject({ code: "TIMEOUT", reason: "upstream_timeout" });
    expect(stopped).toBe(true);
    // Its slot is free again.
    t.setBehaviour((_operation, input) => Promise.resolve(input));
    const next = await t.invoke(t.kai, "connection.crm.echo", { text: "a" });
    expect(next.result).toMatchObject({ status: "done" });
  });
});

describe("the Connection routes", () => {
  it("answer a Connection's operations, secret state and users to whoever may read it", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", {
      operations: [
        operationOf("echo"),
        operationOf("write", { effect: "changing", enabled: false })
      ]
    });
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "helper",
          config: agent("helper", { toolNames: ["known.tool", "connection.crm.echo"] })
        }
      ]
    });
    await t.grant(t.kai.id, "connection.read", { assetId });

    const output = captureProcessOutput();
    let logged: string;
    let body: string;
    try {
      const response = await t.expectOk(t.admin.id, "connections.get", { params: { name: "crm" } });
      body = response.body;
      const detail = connectionDetailSchema.parse(response.json());
      expect(detail).toMatchObject({
        name: "crm",
        health: "unknown",
        secret: { state: "set", version: 1 },
        sharedCredential: true,
        usedBy: [{ agentName: "helper", toolNames: ["connection.crm.echo"] }]
      });
      expect(detail.operations).toEqual([
        {
          name: "echo",
          toolName: "connection.crm.echo",
          effect: "reading",
          exposure: ["agent", "outside"],
          enabled: true,
          status: "ready",
          description: echo.description
        },
        {
          name: "write",
          toolName: "connection.crm.write",
          effect: "changing",
          exposure: ["agent", "outside"],
          enabled: false,
          status: "disabled",
          description: write.description
        }
      ]);
      // Kai reads the Connection and not the agent: the answer names no agent to Kai.
      const forKai = await t.expectOk(t.kai.id, "connections.get", { params: { name: "crm" } });
      body += forKai.body;
      expect(connectionDetailSchema.parse(forKai.json()).usedBy).toEqual([]);
    } finally {
      logged = output.stop();
    }
    // Neither the secret nor its handle is in an answer.
    expect(findLeak(body, t.secret)).toBeUndefined();
    expect(body).not.toMatch(/secret_[0-9a-f-]{36}/u);
    expect(findLeak(logged, t.secret)).toBeUndefined();

    await t.expectRefused(
      t.lena.id,
      "connections.get",
      { params: { name: "crm" } },
      t.forbidden("connection.read", "no_grant")
    );
    await t.expectRefused(
      t.admin.id,
      "connections.get",
      { params: { name: "nothing" } },
      { status: 404, code: "NOT_FOUND" }
    );
  });

  it("test says unavailable, not network_denied, when the listed host does not resolve", async () => {
    // Fails without the change: the test answered `network_denied` and wrote `egress_denied`.
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.read", { assetId });
    t.state.hostResolves = false;
    const tested = z
      .object({ status: z.string() })
      .parse(
        (await t.expectOk(t.admin.id, "connections.test", { params: { name: "crm" } })).json()
      );
    expect(tested.status).toBe("unavailable");
    expect(t.sequence).not.toContain("resolve credential");
    const detail = connectionDetailSchema.parse(
      (await t.expectOk(t.kai.id, "connections.get", { params: { name: "crm" } })).json()
    );
    expect(detail).toMatchObject({ health: "failed", lastErrorCode: "connection_unavailable" });
  });

  it("test a Connection through the same context as a call and write its health", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm");
    await t.grant(t.kai.id, "connection.read", { assetId });
    await t.grant(t.kai.id, "connection.use", { assetId });
    const statusOf = async () =>
      z
        .object({ status: z.string(), testedAt: z.string() })
        .parse(
          (await t.expectOk(t.admin.id, "connections.test", { params: { name: "crm" } })).json()
        ).status;

    t.sequence.length = 0;
    expect(await statusOf()).toBe("ready");
    expect(
      t.sequence.filter((step) => step === "check egress" || step === "resolve credential")
    ).toEqual(["check egress", "resolve credential"]);
    expect(await t.health(assetId)).toBe("ok");

    // The host leaves the egress list: the test says so and resolves no credential.
    t.state.hostAllowed = false;
    t.sequence.length = 0;
    expect(await statusOf()).toBe("network_denied");
    expect(t.sequence).not.toContain("resolve credential");
    expect(await t.health(assetId)).toBe("failed");
    const detail = connectionDetailSchema.parse(
      (await t.expectOk(t.kai.id, "connections.get", { params: { name: "crm" } })).json()
    );
    expect(detail).toMatchObject({ health: "failed", lastErrorCode: "egress_denied" });

    // Reading and using a Connection do not open its test.
    await t.expectRefused(
      t.kai.id,
      "connections.test",
      { params: { name: "crm" } },
      t.forbidden("connection.write", "no_grant")
    );
  });

  it("list the tools an agent can carry, of the Connections the caller may read", async () => {
    const t = await fixture();
    const crm = await t.seed("crm", {
      operations: [
        operationOf("echo"),
        operationOf("write", { effect: "changing", exposure: ["workflow"] })
      ]
    });
    await t.seed("erp");
    await t.seed("off", { enabled: false });
    await t.grant(t.kai.id, "connection.read", { assetId: crm });
    const toolsFor = async (userId: string) =>
      connectionToolsSchema.parse((await t.expectOk(userId, "connections.list_tools")).json());

    expect(await toolsFor(t.kai.id)).toEqual({
      connections: [
        {
          name: "crm",
          title: "Connection crm",
          connectorType: "test",
          tools: [
            {
              toolName: "connection.crm.echo",
              operation: "echo",
              description: echo.description,
              effect: "reading"
            }
          ]
        }
      ]
    });
    expect((await toolsFor(t.admin.id)).connections.map((entry) => entry.name)).toEqual([
      "crm",
      "erp"
    ]);
    // Nothing a person without a right on a Connection can reach.
    expect(await toolsFor(t.lena.id)).toEqual({ connections: [] });
  });
});

describe("the credential of a Connection", () => {
  it("is in no row, no log, no run and no answer after calls that passed, failed and were refused", async () => {
    const t = await fixture();
    const assetId = await t.seed("crm", {
      operations: [operationOf("echo"), operationOf("write", { effect: "changing" })]
    });
    await t.grant(t.kai.id, "connection.use", { assetId });
    await t.grant(t.kai.id, "connection.read", { assetId });
    t.state.agentTools.set("assistant", ["connection.crm.echo"]);
    const answers: string[] = [];

    const output = captureProcessOutput();
    let logged: string;
    try {
      const keep = async (work: Promise<unknown>) =>
        answers.push(
          JSON.stringify(
            await work.catch((error: unknown) =>
              error instanceof AppError ? { message: error.message, details: error.details } : error
            )
          )
        );
      await keep(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
      await keep(
        t.invoke(
          t.kai,
          "connection.crm.echo",
          { text: "a" },
          { origin: agentOrigin("connection.crm.echo") }
        )
      );
      await keep(t.invoke(t.kai, "connection.crm.write", { a: 1 }, { effect: "changing" }));
      await keep(t.invoke(t.lena, "connection.crm.echo", { text: "a" }));
      await keep(t.invoke(t.kai, "connection.crm.echo", { wrong: t.secret.slice(0, 4) }));
      t.setBehaviour(() => Promise.resolve({ leaked: t.secret }));
      await keep(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
      t.setBehaviour((_operation, _input, context) =>
        Promise.reject(new Error(String(context.credentialFor(context.target)?.secret)))
      );
      await keep(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
      t.state.hostAllowed = false;
      await keep(t.invoke(t.kai, "connection.crm.echo", { text: "a" }));
      answers.push(
        (await t.call(t.admin.id, "connections.test", { params: { name: "crm" } })).body
      );
      t.state.hostAllowed = true;
      answers.push(
        (await t.call(t.admin.id, "connections.test", { params: { name: "crm" } })).body
      );
      answers.push((await t.call(t.kai.id, "connections.get", { params: { name: "crm" } })).body);
      answers.push((await t.call(t.kai.id, "connections.list_tools")).body);
    } finally {
      logged = output.stop();
    }

    // The connector did hold it, so the search below is a search for something that was there.
    expect(t.handed.length).toBeGreaterThan(3);
    expect(new Set(t.handed)).toEqual(new Set([t.secret]));
    expect(await t.runs()).not.toHaveLength(0);
    const stored = await dumpDatabaseText();
    for (const [where, text] of Object.entries({ stored, logged, answers: answers.join("\n") })) {
      expect(findLeak(text, t.secret), where).toBeUndefined();
      expect(findLeak(text, t.storeKey), where).toBeUndefined();
    }
  });
});
