import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  type AgentRun
} from "@work-shape/catalyst-core";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { waitUntil } from "./support/assertions";
import { createOAuthWorld, landingOf, type OAuthWorld } from "./support/oauth-sign-in-world";
import { createPersonalOAuthProvider } from "./support/personal-oauth-provider";

// MODEL-REGION-3, end to end: a person in a first-party session asks an agent; it hands the
// reading of mail to a subagent with run_agent. The subagent runs on an allowed (eu) model, but
// the mail would come back to its parent. Where the parent runs on a us model, the subagent's
// personal call is refused before any credential is read; under an eu parent the same call
// reads the mail. Through the API, the Agent Run worker, the runtime and the connection call.

const clientInstanceId = asClientInstanceId("demo-local");
const PUBLIC_URL = "http://localhost:5173";
const MAIL_TOOL = "connection.mailbox.who";
let world: OAuthWorld;
let fake: Awaited<ReturnType<typeof createPersonalOAuthProvider>>;
let alice: string;

beforeAll(async () => {
  fake = await createPersonalOAuthProvider();
  world = await createOAuthWorld({
    extraPort: Number(new URL(fake.base).port),
    outsideModel: true
  });
  alice = await world.signIn("alice");
  expect(await world.putConnection("mailbox", definition(), alice)).toBe(200);
  expect(await world.setSecret("mailbox", fake.clientSecret, alice)).toBe(200);
  const started = await world.start("mailbox", alice);
  const url = new URL(
    z.object({ authorizationUrl: z.string() }).parse(started.body).authorizationUrl
  );
  url.searchParams.set("person", "A");
  expect(
    landingOf((await world.callback(await world.authorize(url.href), { cookie: alice })).location)
      .signIn
  ).toBe("connected");
  fake.responseBody = { subject: "mail-subject-canary" };
  const agent = (name: string, modelBindingId: string, toolNames: string[]) => ({
    type: "upsert" as const,
    kind: "agent",
    name,
    config: {
      name,
      displayName: name,
      instructions: "Follow the tool commands.",
      modelBindingId,
      toolNames,
      ...(toolNames.includes("run_agent") ? { subagentNames: ["reader"] } : {})
    }
  });
  await applyAtCurrentRevisions(world.instance.stores.configAssets, {
    clientInstanceId,
    mutations: [
      agent("lead_outside", "outside", ["run_agent"]),
      agent("lead_eu", "eu", ["run_agent"]),
      agent("reader", "eu", [MAIL_TOOL])
    ]
  });
}, 60_000);
afterAll(async () => {
  await world?.close();
  await fake?.close();
});

function definition() {
  return {
    connectorType: "http_api",
    displayName: "Personal mail",
    credentialMode: "user",
    settings: {
      baseUrl: `${fake.base}/personal-api`,
      oauth: {
        authorizationUrl: `${fake.base}/authorize`,
        tokenUrl: `${fake.base}/token`,
        clientId: "personal-client",
        scopes: ["openid", "email", "sample.read"]
      }
    },
    authScheme: "oauth",
    enabled: true,
    operations: [
      {
        name: "who",
        description: "Read the current account",
        method: "GET",
        path: "/who",
        effect: "reading",
        exposure: ["agent"],
        enabled: true
      }
    ]
  };
}

/** Alice asks `agentName` in a new private chat to have a subagent read her mail. */
async function askToReadMail(agentName: string) {
  const headers = { cookie: alice, origin: PUBLIC_URL };
  const created = await world.instance.call(
    "conversations.create",
    { payload: { title: "Mail", visibility: "private" } },
    { headers }
  );
  expect(created.statusCode, created.body).toBe(200);
  const conversationId = z.object({ id: z.string() }).parse(created.json()).id;
  const task = `/tool ${MAIL_TOOL} {}`;
  const started = await world.instance.call(
    "conversations.runs.start",
    {
      params: { conversationId },
      payload: {
        idempotencyKey: `mail-${agentName}`,
        agentName,
        message: {
          text: `/tool run_agent ${JSON.stringify({ agent: "reader", description: "Mail", task })}`
        }
      }
    },
    { headers }
  );
  expect(started.statusCode, started.body).toBe(200);
  const runId = asAgentRunId(
    z.object({ run: z.object({ id: z.string() }) }).parse(started.json()).run.id
  );
  const runOf = async (id: AgentRun["id"]) => {
    const run = await world.instance.stores.agentRuns.getAgentRun({ clientInstanceId, runId: id });
    if (!run) throw new Error(`No run ${id}`);
    return run;
  };
  await waitUntil(
    async () => ["completed", "failed"].includes((await runOf(runId)).status),
    "the parent run ended"
  );
  const parentEvents = await world.instance.stores.agentRuns.listRunObservations({
    clientInstanceId,
    runId
  });
  const child = parentEvents
    .map((observation) => observation.payload)
    .flatMap((event) => (event.type === "subagent_started" ? [event] : []))[0];
  if (!child) throw new Error("The parent started no subagent");
  const childRunId = asAgentRunId(child.subagentRunId);
  const toolResults = (
    await world.instance.stores.agentRuns.listRunObservations({
      clientInstanceId,
      runId: childRunId
    })
  )
    .map((observation) => observation.payload)
    .filter((event) => event.type === "tool_call_completed" || event.type === "tool_call_failed");
  return {
    conversationId,
    parent: await runOf(runId),
    child: await runOf(childRunId),
    toolResults
  };
}

describe("a subagent's personal call counts the model of the run above it", () => {
  it("refuses the mail under a us parent before anything is fetched, and reads it under an eu parent", async () => {
    const before = fake.headers.length;

    const outside = await askToReadMail("lead_outside");
    expect(outside.child).toMatchObject({ agentName: "reader", parentRunId: outside.parent.id });
    expect(outside.toolResults).toHaveLength(1);
    expect(outside.toolResults[0]).toMatchObject({
      type: "tool_call_failed",
      toolName: MAIL_TOOL,
      result: {
        status: "failed",
        error: {
          message:
            "This instance cannot use personal Connections with its model setup. Every model route of the run has to declare one of the regions allowed for personal Connections: eu."
        }
      }
    });
    // Nothing was fetched and the conversation carries no mark: the refusal comes before both.
    expect(fake.headers).toHaveLength(before);
    const unmarked = await world.instance.stores.conversations.getConversation(
      clientInstanceId,
      asConversationId(outside.conversationId)
    );
    expect(unmarked?.personalDataAt).toBeUndefined();
    // The refusal names the allowed regions, never the parent's route or the mail.
    expect(JSON.stringify(outside.toolResults)).not.toMatch(/outside"|"us"|mail-subject-canary/u);

    // The control: the same subagent under an eu parent reads the mail with Alice's token.
    const allowed = await askToReadMail("lead_eu");
    expect(allowed.toolResults).toHaveLength(1);
    expect(allowed.toolResults[0]).toMatchObject({
      type: "tool_call_completed",
      toolName: MAIL_TOOL
    });
    expect(JSON.stringify(allowed.toolResults[0])).toContain("mail-subject-canary");
    expect(fake.headers).toHaveLength(before + 1);
    expect(fake.headers.at(-1)).toBe(`Bearer ${fake.lastAccess.get("A")}`);
    const marked = await world.instance.stores.conversations.getConversation(
      clientInstanceId,
      asConversationId(allowed.conversationId)
    );
    expect(marked?.personalDataAt).toBeDefined();
  });
});
