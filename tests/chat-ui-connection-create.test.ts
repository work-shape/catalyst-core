import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ConnectionDetail, ConnectionTestResult } from "@vivd-catalyst/api-client";
import {
  ConnectionCreateFlow,
  DISCOVERY_WAIT_MS,
  PendingApprovalError,
  connectConnection,
  discoveredCandidates,
  emptyConnectionForm,
  newConnectionConfig,
  pastedCandidates,
  readingNames,
  type ConnectCalls,
  type ConnectMemory,
  type ConnectionSource
} from "@vivd-catalyst/chat-ui/build-area";
import { connectionDetail } from "./chat-ui-connection-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The New connection dialog (CS-5a 2/2): what "Verbinden" calls and in which order, what it
// does after a refused key or an unreachable address, and the list a person approves tools in.

const KEY = "sk-live-dialog-key-123";
const DISCOVERED_AT = "2026-10-14T10:00:00.000Z";

interface Script {
  /** The answers of `connections.test`, one per call. */
  tests: (ConnectionTestResult["status"] | "held")[];
  /** The detail after the discovery: its tools. */
  discovered?: ConnectionDetail["discovered"];
  /** The discovery never arrives. */
  discoveryNever?: boolean;
}

/** Calls that answer by a script and record what was called, in order, without values. */
function scriptedCalls(script: Script) {
  const calls: string[] = [];
  const writes: { config: Record<string, unknown>; expectedRevision: number | null }[] = [];
  const secrets: { value: string; expectedVersion: number | null }[] = [];
  let revision = 0;
  let discovered = false;
  let clock = 0;
  const tests = [...script.tests];
  const api: ConnectCalls = {
    put: async (config, expectedRevision) => {
      calls.push(`assets.put(${expectedRevision ?? "null"})`);
      writes.push({ config, expectedRevision });
      revision += 1;
      return revision;
    },
    setSecret: async (value, expectedVersion) => {
      calls.push(`connections.set_secret(${expectedVersion ?? "null"})`);
      secrets.push({ value, expectedVersion });
    },
    readDetail: async () => {
      calls.push("connections.get");
      return connectionDetail("crm", {
        secret:
          secrets.length === 0 ? { state: "not_set" } : { state: "set", version: secrets.length },
        discovered: discovered ? (script.discovered ?? []) : [],
        ...(discovered ? { discoveredAt: DISCOVERED_AT } : {})
      });
    },
    test: async () => {
      calls.push("connections.test");
      const next = tests.shift() ?? "ready";
      if (next === "held") throw new PendingApprovalError();
      return { status: next, testedAt: DISCOVERED_AT };
    },
    discover: async () => {
      calls.push("connections.discover");
      discovered = script.discoveryNever !== true;
    },
    pause: async (ms) => {
      clock += ms;
    },
    now: () => clock
  };
  return { api, calls, writes, secrets };
}

const config = (connectorType: "mcp" | "http_api", url: string, key: string) =>
  newConnectionConfig(
    { name: "crm", title: "CRM" },
    {
      ...emptyConnectionForm(connectorType),
      url,
      authScheme: key === "" ? "none" : "bearer"
    }
  );

async function connect(
  calls: ConnectCalls,
  input: { connectorType: "mcp" | "http_api"; url: string; key: string },
  memory: ConnectMemory = {}
) {
  const steps: string[] = [];
  const outcome = await connectConnection(
    calls,
    {
      config: config(input.connectorType, input.url, input.key),
      url: input.url,
      key: input.key,
      discovers: input.connectorType === "mcp"
    },
    memory,
    (step, state) => steps.push(`${step}:${state}`)
  );
  return { outcome, steps };
}

describe("Verbinden in the New connection dialog", () => {
  it("creates a REST API with no operation, sends the key alone, tests it, and calls nothing else", async () => {
    const run = scriptedCalls({ tests: ["ready"] });
    const { outcome, steps } = await connect(run.api, {
      connectorType: "http_api",
      url: "https://gateway.example.test/datevconnect",
      key: KEY
    });
    expect(outcome.status).toBe("connected");
    expect(run.calls).toEqual([
      "assets.put(null)",
      "connections.set_secret(null)",
      "connections.test"
    ]);
    expect(run.writes[0]?.config).toMatchObject({ connectorType: "http_api", operations: [] });
    // The definition holds no key: it travels through set_secret alone.
    expect(JSON.stringify(run.writes)).not.toContain(KEY);
    expect(run.secrets).toEqual([{ value: KEY, expectedVersion: null }]);
    expect(steps).toEqual(["server:running", "server:done", "key:done"]);
  });

  it("reads the tools of an MCP server after the test and waits for its discovery", async () => {
    const run = scriptedCalls({
      tests: ["ready"],
      discovered: [
        { name: "find_clients", proposedEffect: "reading", fingerprint: "a".repeat(64) },
        { name: "send_message", proposedEffect: "changing", fingerprint: "b".repeat(64) }
      ]
    });
    const { outcome, steps } = await connect(run.api, {
      connectorType: "mcp",
      url: "https://mcp.example.test/mcp",
      key: KEY
    });
    expect(run.calls).toEqual([
      "assets.put(null)",
      "connections.set_secret(null)",
      "connections.test",
      "connections.get",
      "connections.discover",
      "connections.get"
    ]);
    expect(
      outcome.status === "connected" && outcome.detail?.discovered.map((tool) => tool.name)
    ).toEqual(["find_clients", "send_message"]);
    expect(steps.at(-1)).toBe("tools:done");
  });

  it("empties a refused key, and sends the next one typed over the version it reads", async () => {
    const run = scriptedCalls({ tests: ["unauthorized", "ready"] });
    const url = "https://gateway.example.test";
    const first = await connect(run.api, { connectorType: "http_api", url, key: KEY });
    expect(first.outcome).toMatchObject({ status: "refused", reason: "unauthorized" });
    expect(first.steps).toEqual(["server:running", "server:done", "key:failed"]);
    // The refused key is forgotten: the same key typed again is sent again.
    expect(first.outcome.memory.sent).toBeUndefined();
    const second = await connect(
      run.api,
      { connectorType: "http_api", url, key: KEY },
      first.outcome.memory
    );
    expect(second.outcome.status).toBe("connected");
    expect(run.calls.slice(3)).toEqual([
      "assets.put(1)",
      "connections.get",
      "connections.set_secret(1)",
      "connections.test"
    ]);
  });

  it("keeps the key after an unreachable address, and sends it again for a corrected host", async () => {
    const run = scriptedCalls({ tests: ["unavailable", "ready"] });
    const first = await connect(run.api, {
      connectorType: "http_api",
      url: "https://gatewy.example.test",
      key: KEY
    });
    expect(first.outcome).toMatchObject({ status: "refused", reason: "unavailable" });
    expect(first.steps).toEqual(["server:running", "server:failed"]);
    expect(first.outcome.memory.sent).toEqual({ key: KEY, origin: "https://gatewy.example.test" });
    // The host changed, which drops the stored key on the instance: the dialog sends it again,
    // without it being typed again.
    const second = await connect(
      run.api,
      { connectorType: "http_api", url: "https://gateway.example.test", key: KEY },
      first.outcome.memory
    );
    expect(second.outcome.status).toBe("connected");
    expect(run.calls.slice(3)).toEqual([
      "assets.put(1)",
      "connections.get",
      "connections.set_secret(1)",
      "connections.test"
    ]);
    expect(run.secrets.map((secret) => secret.value)).toEqual([KEY, KEY]);

    // A fix of the path on the same host keeps the stored key: nothing is sent again.
    const samehost = scriptedCalls({ tests: ["unavailable", "ready"] });
    const before = await connect(samehost.api, {
      connectorType: "http_api",
      url: "https://gateway.example.test/wrong",
      key: KEY
    });
    await connect(
      samehost.api,
      { connectorType: "http_api", url: "https://gateway.example.test/datevconnect", key: KEY },
      before.outcome.memory
    );
    expect(samehost.secrets).toHaveLength(1);
  });

  it("names a host the instance may not reach, and stops at a call that waits for an approval", async () => {
    const denied = scriptedCalls({ tests: ["network_denied"] });
    expect(
      (await connect(denied.api, { connectorType: "mcp", url: "https://10.0.0.1/mcp", key: "" }))
        .outcome
    ).toMatchObject({ status: "refused", reason: "network_denied" });
    // Without a key nothing is sent.
    expect(denied.calls).toEqual(["assets.put(null)", "connections.test"]);

    const held = scriptedCalls({ tests: ["held"] });
    const { outcome } = await connect(held.api, {
      connectorType: "mcp",
      url: "https://mcp.example.test/mcp",
      key: KEY
    });
    expect(outcome.status).toBe("held");
    expect(held.calls).not.toContain("connections.discover");
  });

  it("stops waiting for the tools at the bound and leaves them for the page", async () => {
    const run = scriptedCalls({ tests: ["ready"], discoveryNever: true });
    const { outcome, steps } = await connect(run.api, {
      connectorType: "mcp",
      url: "https://mcp.example.test/mcp",
      key: ""
    });
    expect(outcome.status).toBe("connected");
    expect(outcome.status === "connected" && outcome.detail?.discoveredAt).toBeUndefined();
    expect(steps.at(-1)).toBe("tools:failed");
    // One read before the discovery, then one a second until the bound.
    expect(run.calls.filter((call) => call === "connections.get").length).toBe(
      DISCOVERY_WAIT_MS / 1_000 + 2
    );
  });
});

describe("the approval list", () => {
  it("ticks only the tools of a custom MCP server whose hint says they only read", () => {
    // `readOnlyHint` true proposes reading; false and a missing hint propose changing.
    const candidates = discoveredCandidates([
      { name: "find_clients", proposedEffect: "reading", fingerprint: "a".repeat(64) },
      { name: "send_message", proposedEffect: "changing", fingerprint: "b".repeat(64) },
      { name: "mark_checked", proposedEffect: "changing", fingerprint: "c".repeat(64) }
    ]);
    expect(readingNames(candidates)).toEqual(["find_clients"]);
    expect(candidates[0]).toMatchObject({
      title: "Find clients",
      effect: "reading",
      schemaFingerprint: "a".repeat(64)
    });
  });

  it("reads pasted operations with their method and path, and says what is wrong with a paste", () => {
    const read = pastedCandidates(`
operations:
  - name: list_clients
    title: Mandanten auflisten
    description: Lists the clients.
    path: /master-data/v1/clients
    exposure: [outside]
    query:
      top: { schema: { type: integer } }
  - name: fiscal_years
    method: GET
    effect: reading
    description: The fiscal years of one client.
    path: /clients/{clientId}/fiscal-years
    pathParams:
      clientId: { schema: { type: string } }
`);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.candidates.map((candidate) => [candidate.title, candidate.request])).toEqual([
      ["Mandanten auflisten", { method: "GET", path: "/master-data/v1/clients" }],
      ["Fiscal years", { method: "GET", path: "/clients/{clientId}/fiscal-years" }]
    ]);
    // The row sets who may use it: a pasted exposure is not taken.
    expect(read.candidates[0]?.declaration).toEqual({
      title: "Mandanten auflisten",
      description: "Lists the clients.",
      path: "/master-data/v1/clients",
      query: { top: { schema: { type: "integer" } } },
      method: "GET"
    });
    expect(readingNames(read.candidates)).toEqual(["list_clients", "fiscal_years"]);

    expect(pastedCandidates("- name: a\n- name: a")).toEqual({
      ok: false,
      issue: { kind: "duplicate", name: "a" }
    });
    expect(pastedCandidates("- path: /x")).toEqual({
      ok: false,
      issue: { kind: "unnamed", index: 1 }
    });
    expect(pastedCandidates("name: a")).toEqual({ ok: false, issue: { kind: "shape" } });
    expect(pastedCandidates("")).toEqual({ ok: false, issue: { kind: "empty" } });
    expect(pastedCandidates("- name: [")).toMatchObject({ ok: false, issue: { kind: "yaml" } });
  });
});

describe("the dialog's first step", () => {
  const source: ConnectionSource = {
    mayTest: () => true,
    useDetail: () => ({ status: "loading" }),
    readDetail: async () => connectionDetail(),
    test: async () => ({ status: "ready", testedAt: DISCOVERED_AT }),
    setSecret: async () => undefined,
    discover: async () => undefined,
    useTest: () => ({ run: { status: "idle" }, start: () => undefined }),
    useHolders: () => ({ status: "hidden" }),
    principalHref: () => ""
  };
  const render = (locale: "en" | "de") =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(ConnectionCreateFlow, {
          source,
          namespaces: [],
          mayNameFreely: true,
          checkName: async () => ({ available: true as const }),
          put: async () => ({ revision: 1 }),
          remove: async () => undefined,
          mayDelete: () => true,
          onClose: () => undefined,
          onCreated: () => undefined
        })
      )
    );

  it("offers an MCP server and a REST API, in English and in German", () => {
    const en = render("en");
    expect(en).toContain("New connection");
    expect(en).toContain('data-connection-type="mcp"');
    expect(en).toContain('data-connection-type="http_api"');
    expect(en).toContain("Names its tools itself.");
    expect(en).toContain("You decide what it reads.");
    const de = render("de");
    expect(de).toContain("Neue Verbindung");
    expect(de).toContain("MCP-Server");
    expect(de).toContain("Du legst fest, was sie liest.");
  });
});
