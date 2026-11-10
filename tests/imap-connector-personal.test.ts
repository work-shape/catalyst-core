import { randomUUID } from "node:crypto";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asToolCallId,
  asUserId,
  createUserPrincipal,
  type AgentRun,
  type AuthenticatedUser,
  type Conversation,
  type JsonObject,
  type OperationCall,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { startImapTestServer, type ImapTestServer } from "./support/imap-test-server";
import { createOAuthWorld, countRows, type OAuthWorld } from "./support/oauth-sign-in-world";
import { makeTestCertificate } from "./support/test-certificate";
import { generateTestSecret } from "./support/test-connector";
import { withTestSql } from "./support/test-sql";

// The Connector type `imap` through the whole call path of an instance: a shared Connection whose
// type answers what only its caller may read. Every call runs only in the caller's own agent
// chat, which it marks, and its Operation Run keeps no input or output. The mailbox is an IMAP
// server in this process with a made-up account.

const clientInstanceId = asClientInstanceId("demo-local");
const HOST = "127.0.0.1";
const USERNAME = "desk@example.test";
const canary = {
  subject: "imap-subject-canary",
  sender: "imap-sender-canary",
  body: "imap-body-canary"
};

let world: OAuthWorld;
let server: ImapTestServer;
let caBefore: string[];
let alice: string, bob: string, a: AuthenticatedUser, b: AuthenticatedUser;
const password = generateTestSecret();

function definition(port: number, exposure: string[] = ["agent"], username = USERNAME) {
  return {
    connectorType: "imap",
    displayName: "Service mailbox",
    credentialMode: "shared",
    settings: { host: HOST, port, username, folders: ["INBOX"] },
    authScheme: "password",
    enabled: true,
    operations: [
      { name: "search_messages", effect: "reading", exposure, enabled: true },
      { name: "get_message", effect: "reading", exposure: ["agent"], enabled: true }
    ]
  };
}

beforeAll(async () => {
  const certificate = makeTestCertificate(HOST);
  caBefore = getCACertificates("default");
  setDefaultCACertificates([...caBefore, certificate.authority]);
  server = await startImapTestServer({
    tls: certificate,
    account: { username: USERNAME, password },
    folders: {
      INBOX: {
        uidValidity: 3,
        messages: [
          {
            uid: 1,
            date: new Date("2026-10-01T08:00:00Z"),
            subject: canary.subject,
            from: [{ name: "Sender", mailbox: canary.sender, host: "example.test" }],
            to: [{ mailbox: "desk", host: "example.test" }],
            body: { type: "text/plain", charset: "utf-8", body: `Hello, ${canary.body}.` }
          }
        ]
      }
    }
  });
  world = await createOAuthWorld({ imapsPort: server.port });
  alice = await world.signIn("alice");
  bob = await world.signIn("bob");
  a = await world.identityOf(alice);
  b = await world.identityOf(bob);
  expect(await world.putConnection("mailbox", definition(server.port), alice)).toBe(200);
  expect(await world.setSecret("mailbox", password, alice)).toBe(200);
}, 60_000);

afterAll(async () => {
  await world?.close();
  await server?.close();
  if (caBefore) setDefaultCACertificates(caBefore);
});

async function conversation(actor = a, shared?: "private" | "workspace"): Promise<Conversation> {
  const workspace = shared
    ? await world.worker.stores.workspaces.createWorkspace({
        clientInstanceId,
        name: `Shared ${randomUUID()}`,
        kind: "shared",
        creatorUserId: asUserId(actor.id)
      })
    : await world.worker.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(actor.id)
      });
  return world.worker.stores.conversations.createConversation({
    clientInstanceId,
    collaborationWorkspaceId: workspace.id,
    createdByUserId: asUserId(actor.id),
    createdByExternalUserId: actor.externalUserId,
    visibility: shared ?? "workspace",
    title: "Mailbox",
    retainedUntil: "2099-01-01T00:00:00.000Z"
  });
}

async function prepare(actor = a, chat?: Conversation) {
  const root = chat ?? (await conversation(actor));
  const message = await world.worker.stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: root.id,
    role: "user",
    text: "Read the mailbox"
  });
  const run = await world.worker.stores.agentRuns.createAgentRun({
    id: asAgentRunId(`run_${randomUUID()}`),
    clientInstanceId,
    conversationId: root.id,
    ownerUserId: actor.id,
    inputMessageId: message.id,
    agentName: "mailbox-fixture",
    status: "running",
    startedAt: new Date().toISOString(),
    correlationId: randomUUID(),
    authorization: {
      personalConnectionsAllowed: true,
      principal: createUserPrincipal(actor),
      subjectUserId: actor.id,
      scopes: ["*"]
    }
  });
  return { root, run, actor };
}

function origin(run: AgentRun, toolName: string): Extract<OperationOrigin, { kind: "agent" }> {
  return {
    kind: "agent",
    agentRunId: run.id,
    conversationId: run.conversationId,
    agentName: run.agentName,
    toolCallId: asToolCallId(`call_${randomUUID()}`),
    toolName
  };
}

async function call(
  prepared: Awaited<ReturnType<typeof prepare>>,
  operation = "search_messages",
  input: JsonObject = { subject: "canary" },
  patch: Partial<OperationCall> = {}
) {
  const calls = await world.calls();
  const name = `connection.mailbox.${operation}`;
  return runOperation(
    {
      operation: name,
      effect: "reading",
      input,
      actor: prepared.actor,
      origin: origin(prepared.run, name),
      correlationId: randomUUID(),
      ...patch
    },
    { ...calls.deps, agentToolNames: () => [name] },
    { modelRoutes: [{ id: "local", region: "eu" }] }
  );
}

async function refusedBeforeContact(
  prepared: Awaited<ReturnType<typeof prepare>>,
  patch: Partial<OperationCall>,
  reason = "personal_connection_context"
) {
  const before = server.connections();
  const answer = await call(prepared, "search_messages", { subject: "canary" }, patch);
  expect(answer.result).toMatchObject({ status: "failed", error: { details: { reason } } });
  expect(server.connections()).toBe(before);
}

describe("an imap Connection on the call path", () => {
  it("accepts the exposure agent only at save", async () => {
    for (const exposure of [["agent", "workflow"], ["bridge"], ["agent", "outside"]]) {
      expect(
        await world.putConnection("other-mailbox", definition(server.port, exposure), alice)
      ).toBe(422);
    }
  });

  it("is tested by an administrator without reading mail", async () => {
    const before = server.commands.length;
    const probe = await world.test("mailbox", alice);
    expect(probe.status, probe.text).toBe(200);
    expect(probe.text).toContain("ready");
    const sent = server.commands.slice(before).map((command) => command.name);
    expect(sent).toContain("EXAMINE");
    expect(sent.some((name) => name.includes("FETCH") || name.includes("SEARCH"))).toBe(false);
  });

  it("refuses every surface but the caller's own agent chat before it connects", async () => {
    const p = await prepare();
    const surfaces: OperationOrigin[] = [
      { kind: "user" },
      { kind: "cli" },
      { kind: "mcp", clientName: "platform MCP" },
      { kind: "schedule", scheduleId: "direct-schedule" },
      { kind: "app", appRevisionId: "rev", actionName: "read", pageSessionId: "session" },
      { kind: "workflow", workflowRunId: "workflow", stepRunId: "step" }
    ];
    for (const from of surfaces) await refusedBeforeContact(p, { origin: from });
    // A chat others can read, and one another person created.
    await refusedBeforeContact(await prepare(a, await conversation(a, "workspace")), {});
    await refusedBeforeContact(await prepare(a, await conversation(b)), {});
    // A key, which a CLI or an outside client calls with.
    await refusedBeforeContact(p, { actor: { ...a, keyScopes: ["*"] } });
  });

  it("refuses a person without connection.use before it connects", async () => {
    const p = await prepare(b, await conversation(b, "private"));
    const stripped: AuthenticatedUser = {
      ...b,
      roles: ["user"],
      permissions: [],
      permissionRefs: []
    };
    const before = server.connections();
    const answer = await call(
      { ...p, actor: stripped },
      "search_messages",
      {},
      { actor: stripped }
    );
    expect(answer.result.status).not.toBe("done");
    expect(JSON.stringify(answer.result)).toContain("connection.use");
    expect(server.connections()).toBe(before);
  });

  it("reads in the caller's own chat, marks it, and keeps no mail in the run or the audit", async () => {
    const p = await prepare(a, await conversation(a, "private"));
    const searched = await call(p);
    expect(searched.result.status).toBe("done");
    if (searched.result.status !== "done") return;
    const { items } = z
      .object({ items: z.array(z.object({ id: z.string(), subject: z.string() }).loose()) })
      .parse(searched.result.output);
    expect(items.map((item) => item.subject)).toEqual([canary.subject]);
    const read = await call(p, "get_message", { id: items[0]?.id ?? "" });
    expect(read.result).toMatchObject({
      status: "done",
      output: { text: `Hello, ${canary.body}.` }
    });

    const marked = await world.worker.stores.conversations.getConversation(
      clientInstanceId,
      p.root.id
    );
    expect(marked?.personalDataAt).toBeDefined();
    for (const answer of [searched, read]) {
      const row = await world.worker.stores.operationRuns.get({
        clientInstanceId,
        id: answer.run.id
      });
      expect(row).toMatchObject({ ownerUserId: a.id });
      expect(row?.inputRef).toBeUndefined();
      expect(row?.output).toBeUndefined();
      expect(row?.resultBytes).toBeGreaterThan(0);
    }
    const persisted = await withTestSql(async (sql) => ({
      audit: await sql`select * from audit_events`,
      runs: await sql`select * from operation_runs`
    }));
    const text = JSON.stringify(persisted);
    for (const value of [...Object.values(canary), USERNAME, password])
      expect(text).not.toContain(value);
    expect(server.flagsOf("INBOX", 1)).toEqual([]);
  });

  it("deletes the secret when the user name changes, and keeps it when the folders do", async () => {
    expect(await world.putConnection("moving", definition(server.port), alice)).toBe(200);
    expect(await world.setSecret("moving", password, alice)).toBe(200);
    const stored = await countRows("secrets");
    expect(
      await world.putConnection(
        "moving",
        definition(server.port, ["agent"], "other@example.test"),
        alice
      )
    ).toBe(200);
    expect(await countRows("secrets")).toBe(stored - 1);
    // The folders are no part of the binding: the secret stays.
    expect(await world.setSecret("moving", password, alice)).toBe(200);
    expect(
      await world.putConnection(
        "moving",
        {
          ...definition(server.port, ["agent"], "other@example.test"),
          settings: {
            host: HOST,
            port: server.port,
            username: "other@example.test",
            folders: ["INBOX", "Orders"]
          }
        },
        alice
      )
    ).toBe(200);
    expect(await countRows("secrets")).toBe(stored);
  });
});
