import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  type AgentRun,
  type AuthenticatedUser,
  type ToolExecutionRequest
} from "@work-shape/catalyst-core";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { waitUntil } from "./support/assertions";
import { createOAuthWorld, landingOf, type OAuthWorld } from "./support/oauth-sign-in-world";
import { getTestExecution } from "./support/test-instance";

// The sample serves plain http on 127.0.0.1, which a person's own server reaches only under the
// operator's rule (PMCP-3); this file is about where its tools are offered and called.
vi.mock("@work-shape/catalyst-core", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  egressRuleOf: () => "operator"
}));

// PMCP-4, end to end (connections acceptance check 80): Carol adds an MCP server for herself and
// accepts a reading and a changing tool. In her own private chat the instance's agent, which
// lists neither, calls both: the read answers, the change asks her, she confirms and it runs.
// Through the API, the Agent Run worker, the runtime and the Connection's call. The same call is
// refused when the tool call is made: by another person, in a subagent's thread, and with a key.

const clientInstanceId = asClientInstanceId("demo-local");
const PUBLIC_URL = "http://localhost:5173";
const SERVER = "carol-notes";
const READ = `connection.${SERVER}.list_customers`;
const CHANGE = `connection.${SERVER}.list_orders`;
const startSchema = z.object({ authorizationUrl: z.string() });

let world: OAuthWorld;
let carol: string;
let dave: string;

/** Carol's own server, as the add stores it: `ownerOnly`, mode `user`, at the sample. */
function own(operations: unknown[] = []) {
  return {
    name: SERVER,
    connectorType: "mcp",
    credentialMode: "user",
    authScheme: "oauth",
    displayName: "My notes",
    settings: { url: `${world.sample}/dcr/mcp` },
    operations,
    enabled: true,
    ownerOnly: true
  };
}

async function putOwn(operations: unknown[] = []) {
  const stored = await world.instance.stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "connection",
    name: SERVER
  });
  const answer = await world.instance.call(
    "assets.put",
    {
      params: { kind: "connection", name: SERVER },
      payload: { config: own(operations), expectedRevision: stored?.revision ?? null }
    },
    { headers: { cookie: carol, origin: PUBLIC_URL } }
  );
  expect(answer.statusCode, answer.body).toBe(200);
}

beforeAll(async () => {
  world = await createOAuthWorld({
    plainPeople: true,
    // On, as an operator or PMCP-5 turns it on: the release default is off.
    ownServers: { enabled: true, perPerson: 3 }
  });
  carol = await world.signIn("carol");
  dave = await world.signIn("dave");
  await putOwn();
  const started = await world.start(SERVER, carol);
  expect(started.status).toBe(200);
  const back = await world.authorize(startSchema.parse(started.body).authorizationUrl);
  expect(landingOf((await world.callback(back, { cookie: carol })).location).signIn).toBe(
    "connected"
  );
  await world.discover(SERVER, carol);
  // Its owner accepts one tool as reading and marks another as changing.
  await putOwn([
    { name: "list_customers", effect: "reading", exposure: ["agent"] },
    { name: "list_orders", effect: "changing", exposure: ["agent"] }
  ]);
  // What it accepted is callable after the next discovery.
  await world.discover(SERVER, carol);
  // The instance's agent lists neither tool; a subagent it may start lists nothing either.
  await applyAtCurrentRevisions(world.instance.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: "test_agent",
        config: {
          name: "test_agent",
          displayName: "Test Agent",
          instructions: "Follow the tool commands.",
          modelProviderId: "local",
          toolNames: ["run_agent"],
          subagentNames: ["reader"]
        }
      },
      {
        type: "upsert",
        kind: "agent",
        name: "reader",
        config: {
          name: "reader",
          displayName: "Reader",
          instructions: "Follow the tool commands.",
          modelProviderId: "local",
          toolNames: []
        }
      }
    ]
  });
}, 90_000);
afterAll(async () => {
  await world?.close();
});

const runOf = async (runId: string): Promise<AgentRun> => {
  const run = await world.instance.stores.agentRuns.getAgentRun({
    clientInstanceId,
    runId: asAgentRunId(runId)
  });
  if (!run) throw new Error(`No run ${runId}`);
  return run;
};

const eventsOf = async (runId: string) =>
  (
    await world.instance.stores.agentRuns.listRunObservations({
      clientInstanceId,
      runId: asAgentRunId(runId)
    })
  ).map((observation) => observation.payload);

const callsOf = async (runId: string) =>
  (await world.instance.stores.operationRuns.list({ clientInstanceId })).filter(
    (run) => run.origin.kind === "agent" && run.origin.agentRunId === runId
  );

/** A person's message in a new private chat of theirs, with the run it starts. */
async function say(cookie: string, text: string) {
  const headers = { cookie, origin: PUBLIC_URL };
  const created = await world.instance.call(
    "conversations.create",
    { payload: { title: "Notes", visibility: "private" } },
    { headers }
  );
  expect(created.statusCode, created.body).toBe(200);
  const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
  const started = await world.instance.call(
    "conversations.runs.start",
    {
      params: { conversationId },
      payload: {
        idempotencyKey: createPlatformId("start"),
        agentName: "test_agent",
        message: { text }
      }
    },
    { headers }
  );
  expect(started.statusCode, started.body).toBe(200);
  const runId = z.object({ run: z.object({ id: z.string() }) }).parse(started.json()).run.id;
  return { conversationId, runId };
}

const until = (runId: string, statuses: string[]) =>
  waitUntil(
    async () => statuses.includes((await runOf(runId)).status),
    `the run is ${statuses.join(" or ")}`
  );

const toolResults = async (runId: string) =>
  (await eventsOf(runId)).filter(
    (event) => event.type === "tool_call_completed" || event.type === "tool_call_failed"
  );

describe("a person's own MCP server in their own private chat", () => {
  let readRun: { conversationId: string; runId: string };

  it("answers a reading tool the agent does not list", async () => {
    readRun = await say(carol, `/tool ${READ} {}`);
    await until(readRun.runId, ["completed", "failed"]);

    expect(await runOf(readRun.runId)).toMatchObject({ status: "completed" });
    const [result, ...rest] = await toolResults(readRun.runId);
    expect(rest).toEqual([]);
    expect(result).toMatchObject({ type: "tool_call_completed", toolName: READ });
    expect(JSON.stringify(result)).toContain("customers");
    expect(await callsOf(readRun.runId)).toMatchObject([{ operation: READ, status: "done" }]);
  });

  it("asks before a changing tool, and runs it once its owner confirmed", async () => {
    const said = await say(carol, `/tool ${CHANGE} {}`);
    await until(said.runId, ["waiting_for_decision", "completed", "failed"]);
    const [waiting] = await callsOf(said.runId);
    expect(await runOf(said.runId)).toMatchObject({ status: "waiting_for_decision" });
    expect(waiting).toMatchObject({ operation: CHANGE, status: "pending_confirmation" });
    if (!waiting) throw new Error("No waiting call");
    expect((await eventsOf(said.runId)).at(-1)).toMatchObject({
      type: "tool_decision_requested",
      operationRunId: waiting.id,
      mode: "confirm"
    });

    // Another person cannot decide it.
    const foreign = await world.instance.call(
      "operations.decide",
      { params: { runId: waiting.id }, payload: { decision: "confirm" } },
      { headers: { cookie: dave, origin: PUBLIC_URL } }
    );
    expect(foreign.statusCode).not.toBe(200);

    const confirmed = await world.instance.call(
      "operations.decide",
      { params: { runId: waiting.id }, payload: { decision: "confirm" } },
      { headers: { cookie: carol, origin: PUBLIC_URL } }
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    await until(said.runId, ["completed", "failed"]);

    expect(await runOf(said.runId)).toMatchObject({ status: "completed" });
    expect(await callsOf(said.runId)).toMatchObject([
      { id: waiting.id, operation: CHANGE, status: "done", decision: { mode: "confirmed" } }
    ]);
    const results = await toolResults(said.runId);
    expect(results.at(-1)).toMatchObject({ type: "tool_call_completed", toolName: CHANGE });
    expect(JSON.stringify(results.at(-1))).toContain("orders");
  });

  it("is refused at the call by another person, in a subagent's thread and with a key", async () => {
    const execution = getTestExecution(world.worker);
    const { runTool } = execution.localAgentRuntimeOptions;
    const carolIs = await world.identityOf(carol);
    const call = (
      request: Pick<ToolExecutionRequest, "agentRunId" | "conversationId" | "agentName">,
      user: AuthenticatedUser
    ) => {
      const toolRequest: ToolExecutionRequest = {
        ...request,
        toolName: READ,
        toolCallId: asToolCallId(createPlatformId("toolcall")),
        input: {}
      };
      return runTool(toolRequest, {
        clientInstanceId,
        correlationId: createPlatformId("corr"),
        user,
        // The route the run's model takes, as the worker hands it on.
        modelRoutes: [{ id: "local", region: "eu" }]
      });
    };
    const carolRun = {
      agentRunId: asAgentRunId(readRun.runId),
      conversationId: asConversationId(readRun.conversationId),
      agentName: "test_agent"
    };

    // The control: Carol's own run, as the tool call of her run makes it.
    expect(await call(carolRun, carolIs)).toMatchObject({ status: "success" });

    // Dave's own run in his own private chat.
    const daveRun = await say(dave, "Hello");
    await until(daveRun.runId, ["completed", "failed"]);
    const refusedFor = [
      [
        "another person's run",
        await call(
          {
            agentRunId: asAgentRunId(daveRun.runId),
            conversationId: asConversationId(daveRun.conversationId),
            agentName: "test_agent"
          },
          await world.identityOf(dave)
        )
      ],
      ["another person for the owner's run", await call(carolRun, await world.identityOf(dave))],
      [
        "the owner's key",
        await call(carolRun, {
          ...carolIs,
          delegatedActor: {
            kind: "api_key",
            id: createPlatformId<"ApiCredentialId">("key"),
            displayLabel: "Key",
            authSource: "test"
          },
          keyScopes: ["*"]
        })
      ]
    ] as const;

    // A subagent Carol's run started, in its thread.
    const parent = await say(
      carol,
      `/tool run_agent ${JSON.stringify({ agent: "reader", description: "Notes", task: "Hello" })}`
    );
    await until(parent.runId, ["completed", "failed"]);
    const started = (await eventsOf(parent.runId)).flatMap((event) =>
      event.type === "subagent_started" ? [event] : []
    )[0];
    if (!started) throw new Error("The parent started no subagent");
    const child = await runOf(started.subagentRunId);
    expect(child.parentRunId).toBe(parent.runId);
    const inThread = await call(
      { agentRunId: child.id, conversationId: child.conversationId, agentName: "reader" },
      carolIs
    );

    for (const [what, result] of [...refusedFor, ["a subagent's thread", inThread] as const]) {
      expect(result, what).toMatchObject({ status: "failed", error: { code: "not_allowed" } });
    }
    // Only the control's call reached the server.
    const reads = (await world.instance.stores.operationRuns.list({ clientInstanceId })).filter(
      (run) => run.operation === READ
    );
    expect(reads.map((run) => run.status)).toEqual(["done", "done"]);
  });
});
