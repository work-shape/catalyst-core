import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { createJobWorker, resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  NOTICE_KIND,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asServicePrincipalId,
  asUserId,
  createPlatformId,
  type ClientInstanceId,
  type Logger,
  type NoticeSendInput,
  type WorkflowRunPrincipal
} from "@work-shape/catalyst-core";
import {
  CaptureMailTransport,
  TemplateMailSender,
  type MailTransport,
  type RenderedMail
} from "@work-shape/catalyst-mail";
import { createNoticeMailJobs, createNotices } from "@work-shape/catalyst-server";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestConfig, type TestInstance } from "./support/test-instance";

// NOTIFY-a: a Workflow's notice reaches the active users and Shared Workspace members it names,
// each once, as an Inbox item only they see and answer, and, with `mail`, a mail that links to
// that item and holds no word of the notice. All of it against Postgres and the Inbox routes.

const APP_URL = "https://chat.example.test/";
/** Words that may stand only in the Inbox item, never in a mail, an audit event or a log. */
const TITLE = "Buchhaltungscheck 2026-09 (Mandant Muster GmbH)";
const TEXT = "12 findings in 3 Mandanten. Kontoauszug 4711 of Muster GmbH is missing.";

function person(id: string, roles = ["user"]) {
  return { id, externalUserId: id, displayLabel: id, roles, permissionRefs: [] };
}

const itemSchema = z.looseObject({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  summary: z.string(),
  addresseeUserId: z.string().optional(),
  canDecide: z.boolean(),
  preview: z.looseObject({})
});
const listSchema = z.object({ items: z.array(itemSchema) });

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** A transport that keeps mails, and fails for one address as a provider would. */
class FlakyCapture implements MailTransport {
  readonly capture = new CaptureMailTransport();
  private failed = false;
  constructor(private readonly failFor?: string) {}
  async deliver(mail: RenderedMail) {
    if (mail.to.email === this.failFor && !this.failed) {
      this.failed = true;
      throw new Error(`provider refused ${TITLE}`);
    }
    return this.capture.deliver(mail);
  }
}

function capturingLogger(lines: string[]): Logger {
  const log = (input: unknown, message?: string) => {
    lines.push(JSON.stringify([input, message ?? null]));
  };
  const logger: Logger = {
    debug: log,
    info: log,
    warn: log,
    error: log,
    child: () => logger
  };
  return logger;
}

async function fixture(options: { failMailFor?: string; batchSize?: number; now?: Date } = {}) {
  const config = createTestConfig({
    developmentAuth: {
      enabled: true,
      users: [
        person("ada"),
        person("ben"),
        person("cleo"),
        person("dora"),
        person("finn"),
        // Holds every right of the instance, and is addressed by nothing.
        person("eve", ["user", "admin", "superadmin"])
      ],
      defaultUserId: "ada"
    }
  });
  const app = await createTestInstance({ config, env: {}, tools: [] });
  close = () => app.close();
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const headers = (name: string) => ({ "x-dev-user-id": name });
  const ids: Record<string, string> = {};
  for (const name of ["ada", "ben", "cleo", "dora", "finn", "eve"]) {
    ids[name] = (await app.call("me.get", { headers: headers(name) })).json<{ id: string }>().id;
    // Everyone has an address but Cleo.
    if (name !== "cleo") {
      await app.stores.users.updateUser({
        clientInstanceId,
        userId: asUserId(ids[name] ?? ""),
        email: `${name}@example.test`
      });
    }
  }
  const id = (name: string) => ids[name] ?? "";
  const team = await app.stores.workspaces.createWorkspace({
    clientInstanceId,
    kind: "shared",
    name: "Buchhaltung",
    creatorUserId: asUserId(id("ada"))
  });
  for (const name of ["ben", "cleo", "dora"]) {
    await app.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team.id,
      userId: asUserId(id(name)),
      role: "member"
    });
  }
  // Dora is a member, and disabled.
  await app.stores.users.updateUser({
    clientInstanceId,
    userId: asUserId(id("dora")),
    status: "disabled"
  });
  const transport = new FlakyCapture(options.failMailFor);
  const logs: string[] = [];
  let clock = options.now ?? new Date();
  const mail = {
    sender: new TemplateMailSender(transport, {
      fromAddress: "noreply@example.test",
      fromName: "Example Chat",
      productName: "Example Chat"
    }),
    appUrl: APP_URL
  };
  const mailConfig = parseClientInstanceConfig({
    ...config,
    localization: { defaultLocale: "de", supportedLocales: ["de", "en"] },
    infrastructure: {
      ...config.infrastructure,
      mail: {
        provider: "capture",
        appUrl: APP_URL,
        sender: { fromAddress: "noreply@example.test" },
        notices: { batchSize: options.batchSize ?? 100, digestIntervalMs: 1000 }
      }
    }
  });
  const jobs = createNoticeMailJobs(
    {
      config: mailConfig,
      clientInstanceId,
      stores: app.stores,
      mail,
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: app.stores.audit })
    },
    () => clock
  );
  const worker = createJobWorker({
    stores: app.stores,
    clientInstanceId,
    handlers: jobs.handlers,
    modules: resolveInstanceModules(mailConfig, []).snapshot,
    logger: capturingLogger(logs)
  });
  close = async () => {
    await worker.stop();
    await app.close();
  };
  const deliver = async (advanceMs = 1001) => {
    clock = new Date(clock.getTime() + advanceMs);
    for (const schedule of jobs.schedules)
      await app.stores.jobs.enqueue(schedule.kind, {}, { clientInstanceId });
    await worker.runDue();
  };
  const notices = createNotices({
    delivery: { digestIntervalMs: 1000 },
    now: () => clock,
    clientInstanceId,
    stores: app.stores,
    auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: app.stores.audit }),
    mailConfigured: true
  });
  const principal: WorkflowRunPrincipal = {
    kind: "service",
    id: asServicePrincipalId("sp_monthly_check"),
    displayLabel: "Monatscheck",
    permissionRefs: [],
    permissions: [],
    scopes: [],
    clientInstanceId,
    authSource: "workflow",
    workflowRunId: createPlatformId<"WorkflowRunId">("wfr")
  };
  const send = (input: Partial<NoticeSendInput>) =>
    notices.send(
      {
        from: principal,
        to: {},
        title: TITLE,
        text: TEXT,
        link: { kind: "app", workspaceId: team.id, app: "findings" },
        channels: ["inbox", "mail"],
        ...input
      },
      { correlationId: "corr_notice" }
    );
  const list = async (name: string) =>
    listSchema.parse((await app.call("approval_requests.list", { headers: headers(name) })).json())
      .items;
  /** Every notice item of the instance, whoever it is addressed to. */
  const stored = () =>
    app.stores.approvals.listApprovalRequests({ clientInstanceId, kinds: [NOTICE_KIND] });
  return {
    app,
    clientInstanceId,
    team,
    stored,
    id,
    headers,
    send,
    list,
    logs,
    deliver,
    mails: () => transport.capture.list()
  };
}

async function auditOf(app: TestInstance, clientInstanceId: ClientInstanceId) {
  return app.stores.audit.listAuditEvents({ clientInstanceId });
}

describe("Workflow notices and counts-only mail digests", () => {
  it("rolls back the Inbox and queue together when queueing a mail fails", async () => {
    const f = await fixture();
    const failing = createNotices({
      clientInstanceId: f.clientInstanceId,
      stores: {
        ...f.app.stores,
        transaction: (fn) =>
          f.app.stores.transaction((tx) =>
            fn({
              ...tx,
              noticeMail: {
                ...tx.noticeMail,
                enqueue: () => Promise.reject(new Error("Queue unavailable"))
              }
            })
          )
      },
      auditRecorder: new StoreBackedAuditRecorder({
        clientInstanceId: f.clientInstanceId,
        store: f.app.stores.audit
      }),
      mailConfigured: true
    });
    await expect(
      failing.send(
        {
          from: {
            id: f.id("ada"),
            externalUserId: "ada",
            displayLabel: "Ada",
            roles: ["user"],
            permissionRefs: [],
            clientInstanceId: f.clientInstanceId,
            authSource: "test"
          },
          to: { users: [f.id("ben")] },
          title: TITLE,
          text: TEXT,
          channels: ["inbox", "mail"]
        },
        { correlationId: "queue-failure" }
      )
    ).rejects.toThrow("Queue unavailable");
    expect(await f.stored()).toEqual([]);
    expect(
      await f.app.stores.noticeMail.dueRecipients({
        clientInstanceId: f.clientInstanceId,
        now: new Date(Date.now() + 86400000).toISOString(),
        limit: 10
      })
    ).toEqual([]);
  });

  it("batches recipient digests, retries a provider failure, and never includes sensitive notice content", async () => {
    const f = await fixture({ batchSize: 1, failMailFor: "finn@example.test" });
    for (let index = 0; index < 3; index++)
      await f.send({ to: { users: [f.id("ada"), f.id("ben")] } });
    await f.deliver(999);
    expect(f.mails()).toEqual([]);
    await f.deliver(2);
    expect(f.mails()).toHaveLength(1);
    expect(f.mails()[0]?.text).toContain("3 Mitteilungen");
    await f.deliver();
    expect(f.mails()).toHaveLength(2);
    await f.deliver();
    expect(f.mails()).toHaveLength(2); // already delivered rows are removed
    for (const mail of f.mails()) {
      const rendered = JSON.stringify(mail);
      for (const secret of [TITLE, TEXT, "Muster GmbH", "Kontoauszug 4711"])
        expect(rendered).not.toContain(secret);
    }
    await f.send({ to: { users: [f.id("finn")] } });
    await f.deliver();
    expect(
      await f.app.stores.noticeMail.countPending({
        clientInstanceId: f.clientInstanceId,
        userId: asUserId(f.id("finn")),
        before: new Date(Date.now() + 60_000).toISOString()
      })
    ).toBe(1);
    expect(f.logs.join("\n")).not.toContain(TITLE);
    await f.deliver();
    expect(f.mails()).toHaveLength(3);
  });

  it("counts only waiting notices in a mixed digest", async () => {
    const f = await fixture();
    for (let index = 0; index < 2; index++) await f.send({ to: { users: [f.id("ben")] } });
    const [first] = await f.list("ben");
    if (!first) throw new Error("Expected a notice");
    expect(
      (
        await f.app.call("approval_requests.decide", {
          headers: f.headers("ben"),
          params: { requestId: first.id },
          payload: { decision: "approve" }
        })
      ).statusCode
    ).toBe(200);
    await f.deliver();
    expect(f.mails()).toHaveLength(1);
    expect(f.mails()[0]?.text).toContain("wartet 1 Mitteilung.");
  });

  it("sends no mail and clears due rows when every notice was handled", async () => {
    const f = await fixture();
    await f.send({ to: { users: [f.id("ben")] } });
    const items = await f.list("ben");
    expect(items).toHaveLength(1);
    for (const item of items) {
      expect(
        (
          await f.app.call("approval_requests.decide", {
            headers: f.headers("ben"),
            params: { requestId: item.id },
            payload: { decision: "approve" }
          })
        ).statusCode
      ).toBe(200);
    }
    await f.deliver();
    expect(f.mails()).toEqual([]);
    expect(
      await f.app.stores.noticeMail.dueRecipients({
        clientInstanceId: f.clientInstanceId,
        now: new Date(Date.now() + 60_000).toISOString(),
        limit: 10
      })
    ).toEqual([]);
  });

  it("refuses an unrepresentable delivery date before writing Inbox or outbox rows", async () => {
    const f = await fixture({ now: new Date(8_640_000_000_000_000) });
    await expect(f.send({ to: { users: [f.id("ben")] } })).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "digestIntervalMs must produce a valid delivery date"
    });
    expect(await f.stored()).toEqual([]);
  });

  it("rechecks a recipient at delivery and suppresses mail after disablement", async () => {
    const f = await fixture();
    await f.send({ to: { users: [f.id("ben")] } });
    await f.app.stores.users.updateUser({
      clientInstanceId: f.clientInstanceId,
      userId: asUserId(f.id("ben")),
      status: "disabled"
    });
    await f.deliver();
    expect(f.mails()).toEqual([]);
  });

  it("reaches each active member of a group once, in the Inbox and by a mail without its words", async () => {
    const f = await fixture();
    // Ada, Ben and Finn, who all have an address; Dora is disabled.
    await f.app.stores.workspaces.removeMembership({
      clientInstanceId: f.clientInstanceId,
      collaborationWorkspaceId: f.team.id,
      userId: asUserId(f.id("cleo"))
    });
    await f.app.stores.workspaces.addMembership({
      clientInstanceId: f.clientInstanceId,
      collaborationWorkspaceId: f.team.id,
      userId: asUserId(f.id("finn")),
      role: "member"
    });

    const result = await f.send({ to: { workspaces: [f.team.id] } });

    // Dora, disabled, is skipped and counted.
    expect(result).toEqual({
      addressees: 3,
      inactive: 1,
      mailsSent: 0,
      mailsQueued: 3,
      mailsUnsent: 0
    });
    for (const name of ["ada", "ben", "finn"]) {
      const own = await f.list(name);
      expect(own).toHaveLength(1);
      const [item] = own;
      expect(item).toMatchObject({
        kind: NOTICE_KIND,
        status: "pending",
        summary: TITLE,
        addresseeUserId: f.id(name),
        canDecide: true,
        preview: {
          title: TITLE,
          text: TEXT,
          link: { kind: "app", workspaceId: f.team.id, app: "findings" }
        }
      });
    }
    // Three items in all: none for Dora, none for anyone twice.
    expect((await f.stored()).map((item) => item.addresseeUserId).sort()).toEqual(
      [f.id("ada"), f.id("ben"), f.id("finn")].sort()
    );

    expect(f.mails()).toEqual([]);
    await f.deliver();
    const mails = f.mails();
    expect(mails.map((mail) => mail.to.email).sort()).toEqual([
      "ada@example.test",
      "ben@example.test",
      "finn@example.test"
    ]);
    for (const mail of mails) {
      // The link leads to the addressee's own item, and nothing of the notice is in the mail.
      expect(mail.text).toContain("https://chat.example.test/inbox");
      expect(mail.subject).toBe("Neue Mitteilung in Example Chat");
      for (const part of [mail.subject, mail.text, mail.html]) {
        expect(part).not.toContain("Muster");
        expect(part).not.toContain("12 findings");
      }
    }

    const events = (await auditOf(f.app, f.clientInstanceId)).filter(
      (event) => event.type === "notice.sent"
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: { principalKind: "service", principalId: "sp_monthly_check" },
      metadata: {
        channels: ["inbox", "mail"],
        addressees: 3,
        inactive: 1,
        mailsSent: 0,
        mailsQueued: 3,
        mailsUnsent: 0
      }
    });
    const audit = JSON.stringify(await auditOf(f.app, f.clientInstanceId));
    expect(audit).not.toContain("Muster");
    expect(f.logs.join("\n")).not.toContain("Muster");
  });

  it("reaches only active users of the instance, each once, and counts the others", async () => {
    const f = await fixture({ failMailFor: "finn@example.test" });

    const result = await f.send({
      // Ada twice: once by name and once through the group. Dora, disabled, is named and a
      // member: she counts once.
      to: { users: [f.id("ada"), f.id("finn"), f.id("dora")], workspaces: [f.team.id] }
    });

    // Ada, Ben, Cleo (through the group) and Finn. Cleo has no address; Finn's provider failed.
    expect(result).toEqual({
      addressees: 4,
      inactive: 1,
      mailsSent: 0,
      mailsQueued: 3,
      mailsUnsent: 1
    });
    await f.deliver();
    expect(
      f
        .mails()
        .map((mail) => mail.to.email)
        .sort()
    ).toEqual(["ada@example.test", "ben@example.test"]);
    for (const name of ["ada", "ben", "cleo", "finn"]) {
      expect((await f.list(name)).map((item) => item.addresseeUserId)).toEqual([f.id(name)]);
    }
    expect((await f.stored()).some((item) => item.addresseeUserId === f.id("dora"))).toBe(false);
    const events = (await auditOf(f.app, f.clientInstanceId)).filter(
      (event) => event.type === "notice.sent"
    );
    expect(events[0]?.metadata).toMatchObject({
      inactive: 1,
      mailsSent: 0,
      mailsQueued: 3,
      mailsUnsent: 1
    });
    // The provider's failure is logged without what it said, which here held the title.
    expect(f.logs.join("\n")).not.toContain("Muster");
    expect(f.logs).toHaveLength(0);
  });

  it("refuses the whole notice when an id names no user or Shared Workspace, naming the id", async () => {
    const f = await fixture();
    const evePersonal = await f.app.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId: f.clientInstanceId,
      userId: asUserId(f.id("eve"))
    });
    const cases = [
      // A typo beside a real person: the real person gets nothing either.
      {
        to: { users: [f.id("ada"), "usr_typo_unknown"] },
        fields: ["to.users"],
        unknown: { users: ["usr_typo_unknown"], workspaces: [] }
      },
      // A Personal Workspace is no group; an unknown workspace is none.
      {
        to: { users: [f.id("ben")], workspaces: [f.team.id, evePersonal.id, "cws_nowhere"] },
        fields: ["to.workspaces"],
        unknown: { users: [], workspaces: [evePersonal.id, "cws_nowhere"] }
      }
    ];
    for (const { to, fields, unknown } of cases) {
      const refused = await f.send({ to }).catch((error: unknown) => error);
      expect(refused).toMatchObject({
        code: "VALIDATION_FAILED",
        details: { fields, unknownRecipients: unknown }
      });
      expect(JSON.stringify(refused)).not.toContain("Muster");
    }
    // An address is no id: refused by its field, and not echoed.
    const byAddress = await f
      .send({ to: { users: [f.id("ada"), "eve@example.test"] } })
      .catch((error: unknown) => error);
    expect(byAddress).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fields: ["to.users.1"] }
    });
    expect(JSON.stringify(byAddress)).not.toContain("eve@example.test");

    expect(await f.stored()).toEqual([]);
    expect(f.mails()).toEqual([]);
    const events = await auditOf(f.app, f.clientInstanceId);
    expect(events.some((event) => event.type === "notice.sent")).toBe(false);
  });

  it("refuses a notice that would reach nobody rather than lose it", async () => {
    const f = await fixture();
    // A group whose only member is disabled, and nobody else.
    const empty = await f.app.stores.workspaces.createWorkspace({
      clientInstanceId: f.clientInstanceId,
      kind: "shared",
      name: "Leer",
      creatorUserId: asUserId(f.id("dora"))
    });
    for (const to of [{ users: [f.id("dora")] }, { workspaces: [empty.id] }, {}]) {
      const refused = await f.send({ to }).catch((error: unknown) => error);
      expect(refused).toMatchObject({
        code: "CONFLICT",
        details: { reason: "no_active_recipient" }
      });
    }
    const named = await f.send({ to: { users: [f.id("dora")] } }).catch((error: unknown) => error);
    expect(named).toMatchObject({ details: { inactive: 1 } });
    expect(await f.stored()).toEqual([]);
    expect(f.mails()).toEqual([]);
    const events = await auditOf(f.app, f.clientInstanceId);
    expect(events.some((event) => event.type === "notice.sent")).toBe(false);
  });

  it("never shows a notice to its sender: not in their requests, counts or reads", async () => {
    const f = await fixture();
    const ada = {
      id: f.id("ada"),
      externalUserId: "ada",
      displayLabel: "ada",
      roles: ["user" as const],
      permissionRefs: [],
      clientInstanceId: f.clientInstanceId,
      authSource: "development"
    };
    await f.send({ from: ada, to: { users: [f.id("ben")] }, channels: ["inbox"] });
    const [bensItem] = await f.list("ben");
    const itemId = bensItem?.id ?? "";
    expect(bensItem).toMatchObject({ requestedBy: { id: f.id("ada") } });

    // Ada's own requests and their count: nothing of Ben's.
    const mine = await f.app.call("approval_requests.list_mine", { headers: f.headers("ada") });
    expect(mine.statusCode).toBe(200);
    expect(listSchema.parse(mine.json()).items).toEqual([]);
    const count = await f.app.call("approval_requests.count_pending", {
      headers: f.headers("ada")
    });
    expect(count.json()).toMatchObject({ count: 0, decided: 0, mine: { pending: 0, total: 0 } });
    // Every list and every read by id: the item does not exist for her.
    for (const scope of [undefined, "decided"]) {
      const listed = await f.app.call("approval_requests.list", {
        headers: f.headers("ada"),
        ...(scope ? { query: { scope } } : {})
      });
      expect(listed.body).not.toContain(itemId);
      expect(listed.body).not.toContain("Muster");
    }
    for (const call of [
      f.app.call("approval_requests.get", {
        params: { requestId: itemId },
        headers: f.headers("ada")
      }),
      f.app.call("approval_requests.withdraw", {
        params: { requestId: itemId },
        headers: f.headers("ada")
      }),
      f.app.call("approval_requests.decide", {
        params: { requestId: itemId },
        headers: f.headers("ada"),
        payload: { decision: "approve" }
      })
    ]) {
      const answer = await call;
      expect(answer.statusCode).toBe(404);
      expect(answer.body).not.toContain("Muster");
    }
    expect((await f.list("ben")).map((item) => item.status)).toEqual(["pending"]);

    // A notice Ada sends herself is hers to read, and her list and her count agree.
    await f.send({ from: ada, to: { users: [f.id("ada")] }, channels: ["inbox"] });
    const own = listSchema.parse(
      (await f.app.call("approval_requests.list_mine", { headers: f.headers("ada") })).json()
    ).items;
    expect(own.map((item) => item.addresseeUserId)).toEqual([f.id("ada")]);
    const ownCount = await f.app.call("approval_requests.count_pending", {
      headers: f.headers("ada")
    });
    expect(ownCount.json()).toMatchObject({ count: 1, mine: { pending: 1, total: 1 } });
    // Ben made nothing.
    const bensOwn = await f.app.call("approval_requests.list_mine", { headers: f.headers("ben") });
    expect(listSchema.parse(bensOwn.json()).items).toEqual([]);
  });

  it("shows, counts and lets decide an item to its addressee alone, an admin included", async () => {
    const f = await fixture();
    await f.send({ to: { users: [f.id("ada"), f.id("ben")] }, channels: ["inbox"] });
    expect(f.mails()).toEqual([]);
    const [adaItem] = await f.list("ada");
    const itemId = adaItem?.id ?? "";

    // Eve holds every right of the instance and is not addressed: the item does not exist for
    // her, nor for Ben, who has an item of his own.
    expect(await f.list("eve")).toEqual([]);
    for (const name of ["eve", "ben", "cleo"]) {
      const read = await f.app.call("approval_requests.get", {
        params: { requestId: itemId },
        headers: f.headers(name)
      });
      expect(read.statusCode).toBe(404);
      const decided = await f.app.call("approval_requests.decide", {
        params: { requestId: itemId },
        headers: f.headers(name),
        payload: { decision: "approve" }
      });
      expect(decided.statusCode).toBe(404);
    }
    const count = await f.app.call("approval_requests.count_pending", {
      headers: f.headers("ada")
    });
    expect(count.json<{ count: number }>().count).toBe(1);
    const evesCount = await f.app.call("approval_requests.count_pending", {
      headers: f.headers("eve")
    });
    expect(evesCount.json<{ count: number }>().count).toBe(0);

    // Ada marks it handled; nothing else changes.
    const handled = await f.app.call("approval_requests.decide", {
      params: { requestId: itemId },
      headers: f.headers("ada"),
      payload: { decision: "approve" }
    });
    expect(handled.statusCode).toBe(200);
    expect(handled.json()).toMatchObject({ status: "approved", applyResult: { handled: true } });
    expect((await f.list("ben")).map((item) => item.status)).toEqual(["pending"]);
  });

  it("refuses a notice that is not one, naming the field and not what it held", async () => {
    const f = await fixture();
    const to = { users: [f.id("ada")] };
    // An address beside the ids, as a caller that is not typed might send it.
    const withAddress = { ...to, email: "eve@example.test" };
    for (const input of [
      { to, channels: ["mail" as const] },
      { to, title: `${TITLE}\nsecond line` },
      { to, text: "" },
      { to: withAddress },
      { to, link: { kind: "app" as const, workspaceId: f.team.id, app: "../admin" } }
    ]) {
      const refused = await f.send(input).catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "VALIDATION_FAILED" });
      expect(JSON.stringify(refused)).not.toContain("Muster");
      expect(JSON.stringify(refused)).not.toContain("eve@example.test");
    }
    expect(await f.stored()).toEqual([]);
    expect(f.mails()).toEqual([]);
  });

  it("refuses a sender of another instance", async () => {
    const f = await fixture();
    const refused = await createNotices({
      clientInstanceId: f.clientInstanceId,
      stores: f.app.stores,
      auditRecorder: new StoreBackedAuditRecorder({
        clientInstanceId: f.clientInstanceId,
        store: f.app.stores.audit
      })
    })
      .send(
        {
          from: {
            kind: "service",
            id: asServicePrincipalId("sp_other"),
            displayLabel: "Other",
            permissionRefs: [],
            permissions: [],
            scopes: [],
            clientInstanceId: asClientInstanceId("other_instance"),
            authSource: "workflow",
            workflowRunId: createPlatformId<"WorkflowRunId">("wfr")
          },
          to: { workspaces: [asCollaborationWorkspaceId(f.team.id)] },
          title: TITLE,
          text: TEXT,
          channels: ["inbox"]
        },
        { correlationId: "corr_other" }
      )
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "FORBIDDEN" });
    expect(await f.stored()).toEqual([]);
  });
});
