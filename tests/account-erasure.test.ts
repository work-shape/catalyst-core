import { describe, expect, it } from "vitest";
import {
  asUserId,
  approvalDecisionNote,
  createPlatformId,
  MESSAGE_METADATA_VERSION,
  type ApprovalDecisionMessageMetadata,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ConversationId
} from "@work-shape/catalyst-core";
import { arrangeDeletion } from "./support/deletion-fixture";
import { usePostgresSuite } from "./support/postgres-suite";

/**
 * What the person's account stored beside their id, distinct in each test: the tests share a
 * database. The identity provider's id is the one the fixture signs the person in with.
 */
function personOf(label: string) {
  return {
    NAME: `Erika Mustermann ${label}`,
    EMAIL: `erika.mustermann.${label}@example.test`,
    IDP: `idp-erika-${label}`
  };
}
let { NAME, EMAIL, IDP } = personOf("none");

describe("deleting an account empties the stored copies of the person (ERASE-ACTOR-IDS)", () => {
  const db = usePostgresSuite("accounterasure");

  async function arrange(label: string) {
    ({ NAME, EMAIL, IDP } = personOf(label));
    const t = await arrangeDeletion(db, label);
    const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
    const colleague = await t.createUser("colleague");
    const leaving = await t.createUser(IDP);
    const team = await t.createSharedWorkspace(superadmin, "Team");
    await db.store.workspaces.addMembership({
      ...t.scope,
      collaborationWorkspaceId: team.id,
      userId: asUserId(leaving.id),
      role: "member"
    });
    // A Conversation the person started in the team's workspace outlives their account.
    const shared = await t.createConversation(leaving, "shared", { workspace: team });
    const seeded = await seedCopies(t.scope.clientInstanceId, leaving, colleague, shared.id);
    return { t, superadmin, colleague, leaving, shared, seeded };
  }

  async function seedCopies(
    clientInstanceId: ClientInstanceId,
    person: AuthenticatedUser,
    colleague: AuthenticatedUser,
    conversationId: ConversationId
  ) {
    const uid = person.id;
    const at = "2026-10-20T10:00:00.000Z";
    const ids = {
      requested: createPlatformId("apr"),
      decided: createPlatformId("apr"),
      ownRun: createPlatformId("oprun"),
      decidedRun: createPlatformId("oprun"),
      workflowRun: createPlatformId("wfrun"),
      asset: createPlatformId("asset"),
      agent: createPlatformId("asset"),
      connection: createPlatformId("asset"),
      revision: createPlatformId("rev"),
      feedback: createPlatformId("fb"),
      agentRun: createPlatformId("run"),
      followUp: createPlatformId("fup"),
      input: createPlatformId("msg")
    };
    const actor = { id: uid, label: NAME, externalUserId: IDP };
    // A request the person made, and one of a colleague they decided and then reverted.
    await db.sql`
      insert into approval_requests (id, client_instance_id, kind, summary, payload, requested_by,
        status, decision, created_at, updated_at)
      values
        (${ids.requested}, ${clientInstanceId}, 'operation_call', 'publish',
          ${db.sql.json({ runId: ids.ownRun, actor, subject: { audiencePersonName: NAME } })},
          ${db.sql.json({ id: uid, displayLabel: NAME })}, 'rejected',
          ${db.sql.json({ approved: false, decidedBy: colleague.id, decidedByLabel: "colleague", decidedAt: at })},
          ${at}, ${at}),
        (${ids.decided}, ${clientInstanceId}, 'agent_proposal', 'change', '{}'::jsonb,
          ${db.sql.json({ id: colleague.id, displayLabel: "colleague" })}, 'reverted',
          ${db.sql.json({
            approved: true,
            decidedBy: uid,
            decidedByLabel: NAME,
            decidedAt: at,
            reversion: { revertedBy: uid, revertedByLabel: NAME, revertedAt: at }
          })},
          ${at}, ${at})`;
    // The decision in the Conversation, with the note the model reads.
    const agentRuntime: ApprovalDecisionMessageMetadata = {
      version: MESSAGE_METADATA_VERSION,
      kind: "approval_decision",
      requestId: ids.decided,
      requestKind: "agent_proposal",
      status: "approved",
      decidedBy: uid,
      decidedByLabel: NAME,
      decidedAt: at,
      summary: "change"
    };
    const message = {
      id: `msg_${ids.decided}_approved`,
      text: approvalDecisionNote(agentRuntime),
      metadata: { agentRuntime }
    };
    expect(message.text).toContain(NAME);
    await db.sql`
      insert into messages (id, client_instance_id, conversation_id, role, text, created_at, metadata)
      values (${message.id}, ${clientInstanceId}, ${conversationId}, 'system', ${message.text},
        now(), ${db.sql.json({ agentRuntime: { ...agentRuntime } })})`;
    // A run the person started in the Conversation, and a message they queued behind it, keep
    // how the person was signed in.
    const authorization = {
      principal: {
        kind: "user",
        id: uid,
        displayLabel: NAME,
        clientInstanceId,
        authSource: "oidc",
        externalUserId: IDP
      },
      subjectUserId: uid,
      scopes: []
    };
    await db.sql`
      insert into messages (id, client_instance_id, conversation_id, role, text, created_at, metadata)
      values (${ids.input}, ${clientInstanceId}, ${conversationId}, 'user', 'hello', now(),
        '{}'::jsonb)`;
    await db.sql`
      insert into agent_runs (id, client_instance_id, conversation_id, owner_user_id,
        input_message_id, agent_name, authorization_context, status, started_at, updated_at,
        correlation_id)
      values (${ids.agentRun}, ${clientInstanceId}, ${conversationId}, ${uid}, ${ids.input},
        'helper', ${db.sql.json(authorization)}, 'completed', ${at}, ${at}, 'corr')`;
    await db.sql`
      insert into conversation_follow_ups (id, client_instance_id, conversation_id, author_user_id,
        text, mode, status, position, agent_name, authorization_context, created_at, updated_at,
        dispatched_run_id)
      values (${ids.followUp}, ${clientInstanceId}, ${conversationId}, ${uid}, 'and then', 'queue',
        'consumed', 1, 'helper', ${db.sql.json(authorization)}, ${at}, ${at}, ${ids.agentRun})`;
    await db.sql`
      insert into operation_runs (id, client_instance_id, operation, effect, actor_kind, actor_id,
        actor, origin_kind, origin, input_hash, status, decision, correlation_id, created_at,
        updated_at)
      values
        (${ids.ownRun}, ${clientInstanceId}, 'apps.publish', 'changing', 'user', ${uid},
          ${db.sql.json({ kind: "user", id: uid, label: NAME })}, 'api', '{"kind":"api"}'::jsonb,
          'h', 'done', null, 'corr', ${at}, ${at}),
        (${ids.decidedRun}, ${clientInstanceId}, 'apps.publish', 'changing', 'user',
          ${colleague.id}, ${db.sql.json({ kind: "user", id: colleague.id, label: "colleague" })},
          'api', '{"kind":"api"}'::jsonb, 'h', 'done',
          ${db.sql.json({ mode: "approval", by: uid, byLabel: NAME, at })}, 'corr', ${at}, ${at})`;
    await db.sql`
      insert into workflow_runs (id, client_instance_id, workflow, definition_revision_id, mode,
        trigger, status, input, principal_id, principal_name, principal_label, started_by,
        deadline_at, correlation_id, created_at)
      values (${ids.workflowRun}, ${clientInstanceId}, 'invoices', 'rev_wf', 'test', 'manual',
        'done', '{}'::jsonb, 'sp_x', 'invoices', 'Invoices account',
        ${db.sql.json({ kind: "user", id: uid, label: NAME })}, ${at}, 'corr', ${at})`;
    await db.sql`
      insert into config_assets (id, client_instance_id, kind, name, status, active_revision_id,
        scope_kind, created_at, updated_at)
      values
        (${ids.asset}, ${clientInstanceId}, 'workflow', 'invoices', 'active', 'rev_wf',
          'instance', ${at}, ${at}),
        (${ids.agent}, ${clientInstanceId}, 'agent', 'helper', 'active', ${ids.revision},
          'instance', ${at}, ${at}),
        (${ids.connection}, ${clientInstanceId}, 'connection', 'crm', 'active', 'rev_conn',
          'instance', ${at}, ${at})`;
    await db.sql`
      insert into config_asset_revisions (id, client_instance_id, asset_id, revision, operation,
        actor, global_version, created_at)
      values (${ids.revision}, ${clientInstanceId}, ${ids.agent}, 1, 'create',
        ${db.sql.json({ userId: uid, externalUserId: IDP, displayLabel: NAME, roles: ["user"] })},
        1, ${at})`;
    await db.sql`
      insert into feedback (id, client_instance_id, subject_kind, agent_name, author_user_id,
        text, state, handled_by_user_id, handled_by_label, handled_at, created_at, updated_at)
      values (${ids.feedback}, ${clientInstanceId}, 'message', 'helper', ${colleague.id},
        'too long', 'handled', ${uid}, ${NAME}, ${at}, ${at}, ${at})`;
    await db.sql`
      insert into shipped_guardrail_switches (client_instance_id, guardrail_name, enabled,
        switched_by_id, switched_by_label, switched_at)
      values (${clientInstanceId}, 'pii', false, ${uid}, ${NAME}, ${at})`;
    await db.sql`
      insert into live_once_switches (client_instance_id, asset_id, asset_kind, asset_name, part,
        revision_id, switched_by_id, switched_by_label, switched_at)
      values (${clientInstanceId}, ${ids.asset}, 'workflow', 'invoices', 'send', ${ids.revision},
        ${uid}, ${NAME}, ${at})`;
    await db.sql`
      insert into live_once_runs (client_instance_id, workflow_run_id, part, asset_id, asset_kind,
        asset_name, revision_id, switched_by_id, switched_by_label, switched_at, used_at)
      values (${clientInstanceId}, ${ids.workflowRun}, 'send', ${ids.asset}, 'workflow',
        'invoices', ${ids.revision}, ${uid}, ${NAME}, ${at}, ${at})`;
    // The person's own sign-in at the CRM, revoked when they were closed, and the shared one.
    await db.sql`
      insert into connection_bindings (connection_asset_id, subject, client_instance_id, user_id,
        state, scheme, account_id, account_label, granted_scopes, secret_handle, secret_version,
        connected_at, state_changed_at, origin, row_version)
      values
        (${ids.connection}, ${`user:${uid}`}, ${clientInstanceId}, ${uid}, 'revoked', 'oauth',
          'crm-account-erika', ${EMAIL}, '{}', 'secret_x', 1, ${at}, ${at}, 'chat', 1),
        (${ids.connection}, 'shared', ${clientInstanceId}, null, 'connected', 'oauth',
          'crm-account-team', 'team@crm.example.test', '{}', 'secret_y', 1, ${at}, ${at},
          'chat', 1)`;
    // What audit recorded of the person.
    await db.store.audit.appendAuditEvent({
      clientInstanceId,
      type: "config_asset.updated",
      status: "success",
      actor: { userId: uid, externalUserId: IDP, displayLabel: NAME, roles: ["user"] },
      subject: "invoices",
      correlationId: "corr_audit"
    });
    return { ...ids, messageId: message.id };
  }

  /** Every row of every table, except audit's, that still holds the name, e-mail or IdP id. */
  async function rowsNamingThePerson() {
    const tables = await db.sql<Array<{ table: string }>>`
      select table_name as table from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' and table_name <> 'audit_events'
      order by table_name`;
    const found: string[] = [];
    for (const { table } of tables) {
      const [row] = await db.sql<Array<{ count: number }>>`
        select count(*)::int as count from ${db.sql(table)} t
        where t::text ilike any(${[NAME, EMAIL, IDP].map((value) => `%${value}%`)})`;
      if ((row?.count ?? 0) > 0) found.push(table);
    }
    return found;
  }

  async function expectErased(input: Awaited<ReturnType<typeof arrange>>) {
    const { leaving, colleague, seeded, shared } = input;
    const uid = leaving.id;
    await expect(rowsNamingThePerson()).resolves.toEqual([]);
    // The id stays wherever it was written.
    const [requested] = await db.sql<Array<{ requested_by: unknown; payload: unknown }>>`
      select requested_by, payload from approval_requests where id = ${seeded.requested}`;
    expect(requested?.requested_by).toEqual({ id: uid, displayLabel: "" });
    expect(requested?.payload).toEqual({
      runId: seeded.ownRun,
      actor: { id: uid, label: "" },
      subject: { audiencePersonName: "" }
    });
    const [decided] = await db.sql<Array<{ decision: unknown }>>`
      select decision from approval_requests where id = ${seeded.decided}`;
    expect(decided?.decision).toMatchObject({
      decidedBy: uid,
      decidedByLabel: "",
      reversion: { revertedBy: uid, revertedByLabel: "" }
    });
    const [message] = await db.sql<Array<{ text: string; metadata: { agentRuntime: unknown } }>>`
      select text, metadata from messages where id = ${seeded.messageId}`;
    expect(message?.metadata.agentRuntime).toMatchObject({ decidedBy: uid, decidedByLabel: "" });
    expect(message?.text).toContain("was approved by a deleted account at");
    const runs = await db.sql<Array<{ id: string; actor: unknown; decision: unknown }>>`
      select id, actor, decision from operation_runs where id in (${seeded.ownRun}, ${seeded.decidedRun})
      order by id = ${seeded.ownRun} desc`;
    expect(runs.map((run) => ({ ...run }))).toEqual([
      { id: seeded.ownRun, actor: { kind: "user", id: uid, label: "" }, decision: null },
      {
        id: seeded.decidedRun,
        actor: { kind: "user", id: colleague.id, label: "colleague" },
        decision: { mode: "approval", by: uid, byLabel: "", at: "2026-10-20T10:00:00.000Z" }
      }
    ]);
    const signedIn = {
      principal: {
        kind: "user",
        id: uid,
        displayLabel: "",
        clientInstanceId: shared.clientInstanceId,
        authSource: "oidc"
      },
      subjectUserId: uid,
      scopes: []
    };
    await expect(
      db.sql`select owner_user_id, authorization_context from agent_runs
        where id = ${seeded.agentRun}`
    ).resolves.toEqual([{ owner_user_id: uid, authorization_context: signedIn }]);
    await expect(
      db.sql`select author_user_id, authorization_context from conversation_follow_ups
        where id = ${seeded.followUp}`
    ).resolves.toEqual([{ author_user_id: uid, authorization_context: signedIn }]);
    await expect(
      db.sql`select started_by from workflow_runs where id = ${seeded.workflowRun}`
    ).resolves.toEqual([{ started_by: { kind: "user", id: uid, label: "" } }]);
    await expect(
      db.sql`select actor from config_asset_revisions where id = ${seeded.revision}`
    ).resolves.toEqual([{ actor: { userId: uid, displayLabel: "", roles: ["user"] } }]);
    await expect(
      db.sql`select handled_by_user_id, handled_by_label from feedback where id = ${seeded.feedback}`
    ).resolves.toEqual([{ handled_by_user_id: uid, handled_by_label: "" }]);
    // Still handled, by an account that is gone.
    await expect(
      db.store.feedback.getFeedback({
        clientInstanceId: shared.clientInstanceId,
        id: seeded.feedback
      })
    ).resolves.toMatchObject({ state: "handled", handled: { byUserId: uid, byLabel: "" } });
    for (const table of ["shipped_guardrail_switches", "live_once_switches", "live_once_runs"]) {
      await expect(
        db.sql`select switched_by_id, switched_by_label from ${db.sql(table)}
          where switched_by_id = ${uid}`
      ).resolves.toEqual([{ switched_by_id: uid, switched_by_label: "" }]);
    }
    await expect(
      db.sql`select created_by_user_id, created_by_external_user_id from conversations
        where id = ${shared.id}`
    ).resolves.toEqual([{ created_by_user_id: uid, created_by_external_user_id: "" }]);
    // The person's binding is gone; the shared one stays.
    await expect(
      db.sql`select subject from connection_bindings where connection_asset_id = ${seeded.connection}`
    ).resolves.toEqual([{ subject: "shared" }]);
    // Audit keeps what it recorded until retention.auditDays.
    await expect(
      db.sql`select actor from audit_events where correlation_id = 'corr_audit'`
    ).resolves.toEqual([
      { actor: { userId: uid, externalUserId: IDP, displayLabel: NAME, roles: ["user"] } }
    ]);
  }

  // Fails without the change: every listed table still held the name, e-mail or IdP id, and
  // the person's binding was left with their address.
  it("keeps the id everywhere, empties every copy outside audit and deletes the binding", async () => {
    const arranged = await arrange("erased");
    const { t, leaving } = arranged;
    await expect(rowsNamingThePerson()).resolves.toEqual(
      expect.arrayContaining([
        "agent_runs",
        "approval_requests",
        "config_asset_revisions",
        "connection_bindings",
        "conversation_follow_ups",
        "conversations",
        "feedback",
        "live_once_runs",
        "live_once_switches",
        "messages",
        "operation_runs",
        "shipped_guardrail_switches",
        "workflow_runs"
      ])
    );

    expect((await t.api.call("me.delete", {}, leaving.id)).statusCode).toBe(200);
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    await expectErased(arranged);
  });

  // Fails without the change: the reads echoed the name stored with each record.
  it("names a person whose deletion was requested as a deleted account wherever it is read", async () => {
    const arranged = await arrange("requested");
    const { t, leaving, superadmin, shared, seeded } = arranged;
    // The pass stops at the person's own stored data, so every copy still holds the name.
    const own = await t.createConversation(leaving, "own");
    await t.createData(own);
    t.byteStore.failDeletes = true;
    expect((await t.api.call("me.delete", {}, leaving.id)).statusCode).toBe(202);
    await expect(t.userRow(leaving)).resolves.toEqual([{ marked: true }]);
    await expect(rowsNamingThePerson()).resolves.toContain("messages");

    const messages = await t.api.call(
      "conversations.messages.list",
      { params: { conversationId: shared.id } },
      superadmin.id
    );
    expect(messages.statusCode).toBe(200);
    const decision = messages
      .json<{ items: Array<{ id: string; metadata?: { agentRuntime?: unknown } }> }>()
      .items.find((message) => message.id === seeded.messageId);
    expect(decision?.metadata?.agentRuntime).toMatchObject({
      decidedBy: leaving.id,
      decidedByLabel: ""
    });
    const revisions = await t.api.call(
      "assets.revisions.list",
      { params: { kind: "agent", name: "helper" } },
      superadmin.id
    );
    expect(revisions.statusCode).toBe(200);
    expect(revisions.json()).toMatchObject({
      items: [{ actor: { userId: leaving.id, displayLabel: "" } }]
    });
    // A Workflow Run's starter is read the same way: workflow-run-started-by-name.test.ts.
    expect(JSON.stringify([messages.json(), revisions.json()])).not.toContain(NAME);
  });

  // Fails without the change: the repeated pass left every copy in place.
  it("ends in the same state when a pass is interrupted and repeated", async () => {
    const arranged = await arrange("repeated");
    const { t, leaving } = arranged;
    // The first pass fails as it deletes the user row, after it emptied the copies.
    await db.sql`
      create function erasure_test_interrupt() returns trigger language plpgsql as $$
      begin raise exception 'interrupted'; end $$`;
    await db.sql`
      create trigger erasure_test_interrupt before delete on product_users
      for each row execute function erasure_test_interrupt()`;
    try {
      expect((await t.api.call("me.delete", {}, leaving.id)).statusCode).toBe(202);
      await expect(t.userRow(leaving)).resolves.toEqual([{ marked: true }]);
    } finally {
      await db.sql`drop trigger erasure_test_interrupt on product_users`;
      await db.sql`drop function erasure_test_interrupt()`;
    }

    await t.runDeletionJobs();
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    await expectErased(arranged);
  });

  // Fails without the change: the pass waited for the request's lock for as long as the
  // decision took, and with it the request that asked for the deletion.
  it("does not wait for a request someone is deciding, and empties it in the next pass", async () => {
    const arranged = await arrange("decided");
    const { t, leaving, seeded } = arranged;
    let entered: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A decision on the request the person reverted holds its row until it ends, on a
    // connection of its own.
    const deciding = db.barrierSql.begin(async (sql) => {
      await sql`select id from approval_requests where id = ${seeded.decided} for update`;
      entered();
      await released;
    });
    await holding;
    try {
      expect((await t.api.call("me.delete", {}, leaving.id)).statusCode).toBe(202);
      await expect(t.userRow(leaving)).resolves.toEqual([{ marked: true }]);
    } finally {
      release();
      await deciding;
    }

    await t.runDeletionJobs();
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    await expectErased(arranged);
  });
});
