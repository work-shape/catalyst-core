import { afterEach, describe, expect, it } from "vitest";
import {
  AGENT_RUN_COMMAND_NOT_TAKEN_CODE,
  PLATFORM_REPORTS_PER_HOUR,
  createAssistantFinalMetadata,
  createPlatformId,
  createToolResultMetadata,
  type Logger,
  type ToolExecutionResult,
  type UserRecord
} from "@work-shape/catalyst-core";
import {
  CaptureMailTransport,
  TemplateMailSender,
  type MailSenderIdentity
} from "@work-shape/catalyst-mail";
import { createJobWorker } from "@work-shape/catalyst-client-assembly";
import { createChatServerJobs } from "@work-shape/catalyst-server";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { testServerOptions } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// "Problem an Workshape melden" (PLATFORM-REPORT): a run or a tool that failed for a platform
// reason is reported to the operator's support address as a system mail. The mail carries the
// run, the code, the instance, the time and the person's note; nothing of the conversation.
// The note reaches the mail and nothing else: no audit row, no table, no log line.

const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPORT = "support@operator.example.test";
const QUESTION = "Please total the invoices of client Muster GmbH";
const ANSWER = "The sandbox could not start, so nothing was computed.";
const COMMAND = "python total.py --client muster-secret";
const NOTE = "I was totalling invoices, note-marker-7f3a";
const identity: MailSenderIdentity = {
  fromAddress: "noreply@instance.example.test",
  fromName: "Instance",
  productName: "Instance"
};

let t: AccessInstance | undefined;
let transport: CaptureMailTransport;
let logged: string[];

afterEach(async () => {
  await t?.instance.close();
  t = undefined;
});

/**
 * Every log line as text. The framework's request lines carry the request itself; the process
 * logger writes only its method, address, host and peer of it, so this one does too.
 */
function capturingLogger(): Logger {
  const write = (input: unknown, message?: string) => {
    const fields =
      typeof input === "object" && input !== null && ("req" in input || "res" in input)
        ? { ...input, req: requestLine(Reflect.get(input, "req")), res: undefined }
        : input;
    logged.push(JSON.stringify(fields) ?? "", message ?? "");
  };
  const logger: Logger = {
    debug: write,
    info: write,
    warn: write,
    error: write,
    child: () => logger
  };
  return logger;
}

function requestLine(request: unknown) {
  if (typeof request !== "object" || request === null) return undefined;
  return Object.fromEntries(
    ["method", "url", "host", "ip"].map((key) => [key, Reflect.get(request, key)])
  );
}

async function setup(support: string | null = SUPPORT): Promise<AccessInstance> {
  transport = new CaptureMailTransport();
  logged = [];
  t = await setupAccessInstance({
    server: (_stores, config) => ({
      config: { ...config, support: support ? { email: support } : {} },
      mail: {
        sender: new TemplateMailSender(transport, identity),
        appUrl: "https://chat.instance.example.test",
        listCaptured: () => transport.list()
      },
      logger: capturingLogger()
    })
  });
  return t;
}

type Failure = "tool" | "run" | "none";

/** A conversation of `user` with one run that failed as `failure` says. */
async function failedRun(at: AccessInstance, user: UserRecord, failure: Failure = "tool") {
  const { stores } = at;
  const conversation = await stores.createConversationForTesting({
    clientInstanceId,
    createdByUserId: user.id,
    createdByExternalUserId: user.id,
    title: "Invoices",
    retainedUntil: new Date(Date.now() + 30 * DAY_MS).toISOString()
  });
  const question = await stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: conversation.id,
    role: "user",
    text: QUESTION
  });
  const run = await stores.agentRuns.createAgentRun({
    id: createPlatformId<"AgentRunId">("run"),
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId: user.id,
    inputMessageId: question.id,
    agentName: "assistant",
    correlationId: "corr_platform_report"
  });
  const result: ToolExecutionResult =
    failure === "tool"
      ? {
          status: "failed",
          error: {
            code: "handler_failed",
            message: "The command did not run because the platform's sandbox could not start.",
            details: {
              commandId: "wcmd_test",
              reason: "sandbox_unavailable",
              at: "2026-10-27T09:15:00.000Z"
            }
          }
        }
      : {
          status: "failed",
          error: {
            code: "handler_failed",
            message: "The command exited with 1",
            details: { commandId: "wcmd_test", exitCode: 1 }
          }
        };
  await stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: conversation.id,
    role: "tool",
    text: "",
    metadata: createToolResultMetadata({
      runId: run.id,
      toolCall: { toolCallId: "call_1", toolName: "workspace.exec", input: { command: COMMAND } },
      result,
      modelOutput: { text: "tool output" }
    })
  });
  const finishedAt = new Date().toISOString();
  if (failure === "run") {
    await stores.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: run.id,
      status: "failed",
      updatedAt: finishedAt,
      failedAt: finishedAt,
      error: {
        code: AGENT_RUN_COMMAND_NOT_TAKEN_CODE,
        message: "no worker took the command",
        category: "runtime_interrupted",
        tool: "workspace.exec"
      }
    });
  } else {
    await stores.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "assistant",
      text: ANSWER,
      metadata: createAssistantFinalMetadata({ runId: run.id })
    });
    await stores.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: run.id,
      status: "completed",
      updatedAt: finishedAt,
      completedAt: finishedAt
    });
  }
  return { conversationId: conversation.id, runId: run.id };
}

function report(
  at: AccessInstance,
  user: UserRecord,
  target: { conversationId: string; runId: string },
  payload: { note?: string; replyToMe?: boolean } = {}
) {
  return at.call(user.id, "platform_report.send", {
    params: target,
    payload
  });
}

/** Every row of every table of the database that holds `text`, as `table`. */
async function tablesHolding(text: string): Promise<string[]> {
  return withTestSql(async (sql) => {
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`;
    const found: string[] = [];
    for (const { table_name } of tables) {
      const [row] = await sql<{ hits: number }[]>`
        select count(*)::int as hits from ${sql(table_name)} as t
        where t::text like ${`%${text}%`}`;
      if ((row?.hits ?? 0) > 0) found.push(table_name);
    }
    return found;
  });
}

describe("platform problem reports", () => {
  it("offers nothing and sends nothing where release config names no support address", async () => {
    const at = await setup(null);
    const config = await at.expectOk(at.kai.id, "config.get");
    expect(config.json<{ platformReport?: { available: boolean } }>().platformReport).toEqual({
      available: false
    });
    const target = await failedRun(at, at.kai);
    const refused = await report(at, at.kai, target, { note: NOTE });
    expect(refused.statusCode).toBe(404);
    expect(transport.list()).toHaveLength(0);
  });

  it("mails a tool's platform failure to the support address with the note and nothing of the conversation", async () => {
    const at = await setup();
    const config = await at.expectOk(at.kai.id, "config.get");
    expect(config.json<{ platformReport?: { available: boolean } }>().platformReport).toEqual({
      available: true
    });
    const target = await failedRun(at, at.kai);
    const sent = await report(at, at.kai, target, { note: NOTE });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json<{ id: string }>().id).toMatch(/^prep_/u);

    const [mail, ...more] = transport.list();
    expect(more).toHaveLength(0);
    expect(mail?.to).toEqual({ email: SUPPORT });
    expect(mail?.recipients).toEqual({ to: [{ email: SUPPORT }], cc: [], bcc: [] });
    // The instance's system sender; never the person, and no reply to them unasked.
    expect(mail?.from.email).toBe(identity.fromAddress);
    expect(mail?.replyTo).toBeUndefined();
    for (const part of [mail?.text ?? "", mail?.html ?? ""]) {
      expect(part).toContain(target.runId);
      expect(part).toContain("sandbox_unavailable");
      expect(part).toContain("wcmd_test");
      expect(part).toContain("Access test");
      expect(part).toContain(clientInstanceId);
      expect(part).toContain(NOTE);
      for (const content of [QUESTION, ANSWER, COMMAND, "tool output", "Kai"]) {
        expect(part).not.toContain(content);
      }
    }
    expect(mail?.subject).toContain("sandbox_unavailable");

    // The audit names the run, the report and the code; never the note.
    const audits = await withTestSql(
      (sql) => sql<{ type: string; metadata: unknown; subject: string | null }[]>`
        select type, metadata, subject from audit_events
        where client_instance_id = ${clientInstanceId} and type = 'agent_run.platform_reported'`
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.subject).toBe(target.runId);
    expect(audits[0]?.metadata).toMatchObject({ errorCode: "sandbox_unavailable" });
    expect(await tablesHolding("note-marker-7f3a")).toEqual([]);
    expect(logged.join("\n")).not.toContain("note-marker-7f3a");
  });

  it("reports a run that failed with a platform code, with a reply to the person where they ask", async () => {
    const at = await setup();
    await withTestSql(
      (sql) => sql`update product_users set email = 'kai@client.example.test'
        where client_instance_id = ${clientInstanceId} and id = ${at.kai.id}`
    );
    const target = await failedRun(at, at.kai, "run");
    const sent = await report(at, at.kai, target, { replyToMe: true });
    expect(sent.statusCode, sent.body).toBe(200);
    const [mail] = transport.list();
    expect(mail?.text).toContain(AGENT_RUN_COMMAND_NOT_TAKEN_CODE);
    expect(mail?.from.email).toBe(identity.fromAddress);
    expect(mail?.replyTo?.email).toBe("kai@client.example.test");
  });

  it("refuses a run that failed for no platform reason, and a second report of one run", async () => {
    const at = await setup();
    const plain = await failedRun(at, at.kai, "none");
    const refused = await report(at, at.kai, plain);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      "not_a_platform_failure"
    );

    const target = await failedRun(at, at.kai);
    expect((await report(at, at.kai, target)).statusCode).toBe(200);
    const again = await report(at, at.kai, target);
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      "already_reported"
    );
    // Another person who reads the conversation is not this one: Lena cannot read Kai's.
    expect((await report(at, at.lena, target)).statusCode).toBe(404);
    expect(transport.list()).toHaveLength(1);
  });

  it("takes a few reports per person and hour", async () => {
    const at = await setup();
    for (let index = 0; index < PLATFORM_REPORTS_PER_HOUR; index++) {
      const target = await failedRun(at, at.kai);
      expect((await report(at, at.kai, target)).statusCode).toBe(200);
    }
    const over = await report(at, at.kai, await failedRun(at, at.kai));
    expect(over.statusCode).toBe(429);
    expect(transport.list()).toHaveLength(PLATFORM_REPORTS_PER_HOUR);
    // Somebody else still reports.
    expect((await report(at, at.lena, await failedRun(at, at.lena))).statusCode).toBe(200);
  });

  it("keeps a report's record for 90 days", async () => {
    const at = await setup();
    const old = await failedRun(at, at.kai);
    expect((await report(at, at.kai, old)).statusCode).toBe(200);
    const recent = await failedRun(at, at.kai);
    expect((await report(at, at.kai, recent)).statusCode).toBe(200);
    // One record from 91 days ago, one from 89.
    await withTestSql(
      (sql) => sql`update platform_reports
        set created_at = now() - (case when agent_run_id = ${old.runId}
          then interval '91 days' else interval '89 days' end)`
    );
    const options = testServerOptions(at.instance);
    if (!options) throw new Error("No server options");
    const jobs = createChatServerJobs(options);
    const handler = jobs.handlers.find((entry) => entry.kind.kind === "platform_report.prune");
    const schedule = jobs.schedules.find((entry) => entry.kind.kind === "platform_report.prune");
    if (!handler || !schedule) throw new Error("No prune job");
    const worker = createJobWorker({
      stores: at.stores,
      clientInstanceId,
      logger: options.logger,
      handlers: [handler],
      schedules: [schedule]
    });
    await worker.runDue();
    await worker.stop();
    const left = await withTestSql(
      (sql) => sql<{ agent_run_id: string }[]>`select agent_run_id from platform_reports`
    );
    expect(left.map((row) => row.agent_run_id)).toEqual([recent.runId]);
  });
});
