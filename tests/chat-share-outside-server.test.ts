import { describe, expect, it } from "vitest";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  asCollaborationWorkspaceId,
  asConversationId,
  asUserId,
  chatReadOnlyBy
} from "@work-shape/catalyst-core";
import {
  MISSING,
  as,
  auditRows,
  clientInstanceId,
  createChat,
  createFixture,
  createRun,
  errorSchema,
  operationName,
  readingRoutes,
  reasonOf,
  required,
  share
} from "./support/chat-share-server";
import type { TestCallInput } from "./support/operations";
import type { TestInstance, TestStore } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// CHAT-SHARE-6a (chat-sharing.md 3.9, ADR-0034): the creator of a shared chat names any active
// person of the instance. One who is no member of the chat's workspace reads and continues that
// one chat, and every route of the workspace and every other chat of it answers them as if it
// did not exist. The fixture's `outsider` is in no workspace with the creator.

type Offered = { userId: string; displayLabel: string; email?: string; member: boolean };

async function offer(
  app: TestInstance<TestStore>,
  conversationId: string,
  query?: string
): Promise<Offered[]> {
  const response = await app.call(
    "conversations.share_candidates",
    { params: { conversationId }, ...(query === undefined ? {} : { query: { query } }) },
    as("creator")
  );
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ candidates: Offered[] }>().candidates;
}

async function person(
  app: TestInstance<TestStore>,
  displayLabel: string,
  email: string,
  workspaceId?: string
): Promise<string> {
  const user = await app.stores.users.createUser({ clientInstanceId, displayLabel, email });
  if (workspaceId !== undefined) {
    await app.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: asCollaborationWorkspaceId(workspaceId),
      userId: user.id,
      role: "member"
    });
  }
  return user.id;
}

/** Status, code and message, with the ids the call named put back to one placeholder. */
function answerOf(response: { statusCode: number; json<T>(): T }, ids: readonly string[]) {
  const error = errorSchema.safeParse(response.json()).data?.error;
  const neutral = (text: string) => ids.reduce((out, id) => out.split(id).join("<id>"), text);
  return {
    status: response.statusCode,
    ...(error ? { code: error.code, message: neutral(error.message) } : {})
  };
}

describe("CHAT-SHARE-6a: a shared chat names anyone on the instance", () => {
  it("searches the instance by name from two letters and by the whole address only, members first, and never lists without typing", async () => {
    const { app, ids, workspaceId, conversationId } = await createFixture();
    const outside = await person(app, "Robin Vale", "robin.vale@example.test");
    const member = await person(app, "Robin Ash", "robin.ash@example.test", workspaceId);
    const twin = await person(app, "Robin Vale", "robin.vale.second@example.test");
    const gone = await person(app, "Robin Gone", "robin.gone@example.test");
    await app.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(gone),
      status: "disabled"
    });
    const leaving = await person(app, "Robin Leaving", "robin.leaving@example.test");
    await withTestSql(
      (sql) => sql`update product_users set deletion_requested_at = now() where id = ${leaving}`
    );

    // Bare and one letter: the preselection only, which knows none of them.
    await expect(offer(app, conversationId)).resolves.toEqual([]);
    await expect(offer(app, conversationId, "r")).resolves.toEqual([]);
    // From two letters, by a name or a word of it: members first, then everyone else, each
    // alphabetical; the two of one name show their addresses to tell them apart.
    const found = await offer(app, conversationId, "ro");
    expect(found.map((candidate) => candidate.userId)).toEqual([
      member,
      ...[outside, twin].sort((left, right) => (left < right ? -1 : 1))
    ]);
    expect(found.find((candidate) => candidate.userId === member)).toEqual({
      userId: member,
      displayLabel: "Robin Ash",
      hasAccess: false,
      member: true
    });
    expect(found.find((candidate) => candidate.userId === outside)).toEqual({
      userId: outside,
      displayLabel: "Robin Vale",
      email: "robin.vale@example.test",
      hasAccess: false,
      member: false
    });
    await expect(offer(app, conversationId, "va")).resolves.toHaveLength(2);
    // Never a deactivated person, one whose deletion was requested, or the creator.
    for (const query of ["robin g", "robin l", "Robin Gone", "creator", "cr"]) {
      const named = (await offer(app, conversationId, query)).map((c) => c.userId);
      expect(named, query).not.toContain(gone);
      expect(named, query).not.toContain(leaving);
      expect(named, query).not.toContain(ids.creator);
    }
    // An address across the instance only whole, whatever its case; a prefix of it finds
    // nobody, also beyond two letters.
    for (const prefix of ["robin.vale@", "robin.vale@example.tes", "outsider@example"]) {
      await expect(offer(app, conversationId, prefix), prefix).resolves.toEqual([]);
    }
    await expect(offer(app, conversationId, "ROBIN.VALE@example.test")).resolves.toEqual([
      {
        userId: outside,
        displayLabel: "Robin Vale",
        email: "robin.vale@example.test",
        hasAccess: false,
        member: false
      }
    ]);
    await expect(offer(app, conversationId, "outsider@example.test")).resolves.toMatchObject([
      { userId: ids.outsider, member: false }
    ]);
    await app.close();
  });

  it("limits searches of two letters or more to 30 a minute per person, and counts no shorter one", async () => {
    const { app, conversationId } = await createFixture();
    for (let index = 0; index < 40; index += 1) await offer(app, conversationId, "r");
    for (let index = 0; index < 30; index += 1) await offer(app, conversationId, "ro");
    const limited = await app.call(
      "conversations.share_candidates",
      { params: { conversationId }, query: { query: "rob" } },
      as("creator")
    );
    expect(limited.statusCode).toBe(429);
    expect(errorSchema.parse(limited.json()).error).toMatchObject({
      code: "RATE_LIMITED",
      message: "Too many searches. Wait a moment."
    });
    // The preselection still answers, and nothing of the limit is audited.
    await offer(app, conversationId);
    await app.close();
  });

  it("adds a person outside the team with the outside notice and `outside: true` in the audit, ids only, and refuses whom the rule leaves out", async () => {
    const { app, ids, workspaceId, conversationId } = await createFixture();
    expect((await share(app, conversationId, ids.named)).statusCode).toBe(200);
    const added = await share(app, conversationId, ids.outsider);
    expect(added.statusCode, added.body).toBe(200);
    const rows = await auditRows("conversation.person_added");
    const metadata = rows.map((row) =>
      z
        .object({
          workspaceId: z.string(),
          personId: z.string(),
          outside: z.literal(true).optional(),
          operationRunId: z.string().optional()
        })
        .strict()
        .parse(row.metadata)
    );
    expect(metadata.map(({ personId, outside }) => ({ personId, outside }))).toEqual([
      { personId: ids.named, outside: undefined },
      { personId: ids.outsider, outside: true }
    ]);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toMatch(/Quarter figures|example\.test|outsider"|named"/u);
    }
    const [notice] = await withTestSql(
      (sql) => sql`
        select summary, payload from approval_requests
        where client_instance_id = ${clientInstanceId} and addressee_user_id = ${ids.outsider}`
    );
    expect(notice).toMatchObject({
      summary: "creator shared “Quarter figures” with you",
      payload: {
        text: "You can read the whole chat and write in it. You see nothing else of Team.",
        link: { kind: "conversation", workspaceId, conversationId }
      }
    });

    // A deactivated person, one whose deletion was requested, a service and nobody refuse.
    const gone = await person(app, "Gone", "gone@example.test");
    await app.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(gone),
      status: "disabled"
    });
    const leaving = await person(app, "Leaving", "leaving@example.test");
    await withTestSql(
      (sql) => sql`update product_users set deletion_requested_at = now() where id = ${leaving}`
    );
    for (const userId of [gone, leaving, "sp_share_test", ids.creator]) {
      const refused = await share(app, conversationId, userId);
      expect(reasonOf(refused), userId).toBe("share_person_unavailable");
      expect(errorSchema.parse(refused.json()).error.message, userId).toBe(
        "Only an active person of the instance can be named"
      );
    }
    // The store asks again under the person's row: a deactivation since the check refuses.
    const late = await person(app, "Late", "late@example.test");
    await app.stores.users.updateUser({
      clientInstanceId,
      userId: asUserId(late),
      status: "disabled"
    });
    await expect(
      app.stores.conversations.addConversationPerson({
        clientInstanceId,
        conversationId: asConversationId(conversationId),
        userId: late,
        addedByUserId: ids.creator,
        addedAt: new Date().toISOString(),
        checked: { dataStoreAssetIds: [] }
      })
    ).rejects.toMatchObject({ details: { reason: "share_person_unavailable" } });

    // The limit of 20 counts members and people from outside together.
    const crowded = await createChat(app, workspaceId, "Crowded");
    for (let index = 0; index < 20; index += 1) {
      const userId = await person(
        app,
        `Person ${index}`,
        `person-${index}@example.test`,
        index % 2 === 0 ? workspaceId : undefined
      );
      expect((await share(app, crowded, userId)).statusCode).toBe(200);
    }
    expect(reasonOf(await share(app, crowded, ids.outsider))).toBe("share_people_limit");

    // Nobody else reads the chat alone any more, the creator included.
    const chat = required(
      await app.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(conversationId)
      )
    );
    const workspace = required(
      await app.stores.workspaces.getWorkspace(clientInstanceId, chat.collaborationWorkspaceId)
    );
    expect(chatReadOnlyBy(chat, workspace, ids.creator)).toBe(false);
    expect(chatReadOnlyBy(chat, workspace, ids.outsider)).toBe(false);
    await app.close();
  });

  it("opens the one chat to the person outside, and answers every workspace route and every other chat as missing", async () => {
    const { app, ids, workspaceId, conversationId, runId } = await createFixture();
    expect((await share(app, conversationId, ids.outsider)).statusCode).toBe(200);
    const routes = readingRoutes(runId);
    const send = (name: string, actor: string, id: string) => {
      const input = required(routes[name]);
      return app.call(
        operationName(name),
        { ...input, params: { ...input.params, conversationId: id } },
        as(actor)
      );
    };
    const missingOf = async (name: string) =>
      answerOf(await send(name, "outsider", "conv_missing"), ["conv_missing"]);

    // Every reading route of the chat answers them, with the creator's run in it.
    for (const name of Object.keys(routes)) {
      const answer = await send(name, "outsider", conversationId);
      const body = answer.statusCode >= 400 ? errorSchema.safeParse(answer.json()) : undefined;
      expect(
        { name, missing: body?.success === true && body.data.error.message === MISSING.message },
        name
      ).toEqual({ name, missing: false });
    }
    const thread = await app.call(
      "conversations.thread.get",
      { params: { conversationId } },
      as("outsider")
    );
    expect(thread.statusCode).toBe(200);
    const offered = await app.call(
      "conversations.reader_offer.get",
      { params: { conversationId } },
      as("outsider")
    );
    expect(offered.json()).toMatchObject({
      workspace: { id: workspaceId, name: "Team" },
      outside: true
    });
    const memberOffer = await app.call(
      "conversations.reader_offer.get",
      { params: { conversationId } },
      as("creator")
    );
    expect(memberOffer.json()).toMatchObject({ outside: false });
    const renamed = await app.call(
      "conversations.rename",
      { params: { conversationId }, payload: { title: "Renamed from outside" } },
      as("outsider")
    );
    expect(renamed.statusCode, renamed.body).toBe(200);
    // They name, move and delete nothing.
    expect(reasonOf(await share(app, conversationId, ids.colleague, "outsider"))).toBe(
      "share_creator_only"
    );
    for (const [operation, input] of [
      ["conversations.delete", { params: { conversationId } }],
      [
        "conversations.move",
        { params: { conversationId }, payload: { collaborationWorkspaceId: workspaceId } }
      ]
    ] as const) {
      const refused = await app.call(operation, input, as("outsider"));
      expect(refused.statusCode, operation).toBeGreaterThanOrEqual(400);
    }

    // Every other chat of the workspace, team or private, answers as one that is not there.
    const otherPrivate = await createChat(app, workspaceId, "Other private");
    const team = await createChat(app, workspaceId, "Team chat");
    await withTestSql(
      (sql) => sql`update conversations set visibility = 'workspace' where id = ${team}`
    );
    const teamRun = await createRun(app, team, ids.creator, "completed");
    for (const name of Object.keys(routes)) {
      const missing = await missingOf(name);
      expect(missing.status, name).toBe(404);
      for (const other of [otherPrivate, team]) {
        const input = required(routes[name]);
        const answer = await app.call(
          operationName(name),
          {
            ...input,
            params: {
              ...input.params,
              conversationId: other,
              ...(name === "conversations.runs.observe" ? { runId: teamRun } : {})
            }
          },
          as("outsider")
        );
        expect(answerOf(answer, [other]), `${name} ${other}`).toEqual(missing);
      }
    }

    // Every route that takes the workspace answers as for a workspace that does not exist. A
    // discoverable one shows its directory card and takes access requests from anyone on the
    // instance, named or not; this one is not listed.
    await withTestSql(
      (sql) =>
        sql`update collaboration_workspaces set visibility = 'private' where id = ${workspaceId}`
    );
    const missingWorkspace = "ws_missing";
    const inputFor = (path: string, id: string): TestCallInput => ({
      params: {
        collaborationWorkspaceId: id,
        ...(path.includes(":userId") ? { userId: ids.creator } : {}),
        ...(path.includes(":bundle") ? { bundle: "builder" } : {})
      },
      ...(path.endsWith("/usage")
        ? { query: { from: "2026-01-01", to: "2026-01-31", groupBy: "agent" } }
        : {}),
      payload: {}
    });
    const workspaceRoutes = Object.entries(apiOperations).filter(([, operation]) =>
      (operation as { path: string }).path.includes(":collaborationWorkspaceId")
    );
    expect(workspaceRoutes.length).toBeGreaterThan(20);
    for (const [name, operation] of workspaceRoutes) {
      const { path, effect } = operation as { path: string; effect: string };
      const call = (id: string) =>
        app.call(operationName(name), inputFor(path, id), as("outsider"));
      const missing = answerOf(await call(missingWorkspace), [missingWorkspace]);
      expect(answerOf(await call(workspaceId), [workspaceId]), name).toEqual(missing);
      if (effect === "reading") expect(missing.status, name).toBe(404);
    }
    // And those that take it in the query or the body.
    const byQuery: [string, (id: string) => TestCallInput][] = [
      ["conversations.list", (id) => ({ query: { collaborationWorkspaceId: id } })],
      ["scheduled_starts.list", (id) => ({ query: { collaborationWorkspaceId: id } })],
      ["me.usage.get", (id) => ({ query: { workspaceId: id } })],
      ["assets.list", (id) => ({ params: { kind: "agent" }, query: { workspaceId: id } })],
      ["assets.list", (id) => ({ params: { kind: "skill" }, query: { workspaceId: id } })],
      [
        "conversations.create",
        (id) => ({
          payload: { title: "Mine", collaborationWorkspaceId: id, visibility: "private" }
        })
      ],
      ["projects.create", (id) => ({ payload: { collaborationWorkspaceId: id, title: "Plan" } })]
    ];
    for (const [name, input] of byQuery) {
      const call = (id: string) => app.call(operationName(name), input(id), as("outsider"));
      expect(answerOf(await call(workspaceId), [workspaceId]), name).toEqual(
        answerOf(await call(missingWorkspace), [missingWorkspace])
      );
    }
    const listed = await app.call("workspaces.list", {}, as("outsider"));
    expect(JSON.stringify(listed.json())).not.toContain(workspaceId);

    // Nobody else gains anything: an unnamed member, the Owner and the superadmin.
    for (const actor of ["colleague", "owner"]) {
      expect(
        answerOf(await send("conversations.thread.get", actor, conversationId), [conversationId])
      ).toEqual(await missingOf("conversations.thread.get"));
    }
    await app.close();
  });

  it("ends the outside reader's access by leave, removal and membership end, and keeps it when the creator leaves the team", async () => {
    const { app, ids, workspaceId, conversationId } = await createFixture();
    const read = (actor: string, id = conversationId) =>
      app.call("conversations.thread.get", { params: { conversationId: id } }, as(actor));

    // Leave: the link answers as missing at once.
    expect((await share(app, conversationId, ids.outsider)).statusCode).toBe(200);
    const left = await app.call(
      "conversations.remove_person",
      { params: { conversationId, userId: ids.outsider } },
      as("outsider")
    );
    expect(left.json()).toEqual({ conversationId, userId: ids.outsider, removed: true });
    expect((await read("outsider")).statusCode).toBe(404);

    // Removal waits for their own running turn, then drops their queued follow-up.
    expect((await share(app, conversationId, ids.outsider)).statusCode).toBe(200);
    const running = await createRun(app, conversationId, ids.outsider, "running");
    const waiting = await app.call(
      "conversations.remove_person",
      { params: { conversationId, userId: ids.outsider } },
      as("creator")
    );
    expect(reasonOf(waiting)).toBe("person_run_active");
    const endedAt = new Date().toISOString();
    await app.stores.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: running,
      status: "completed",
      updatedAt: endedAt,
      completedAt: endedAt,
      lastSequence: 0
    });
    await withTestSql(
      (sql) => sql`
        insert into conversation_follow_ups (id, client_instance_id, conversation_id, author_user_id, text, mode, status, position, agent_name, created_at, updated_at)
        values ('fu_outside', ${clientInstanceId}, ${conversationId}, ${ids.outsider}, 'later', 'queue', 'pending', 1, 'default', now(), now())`
    );
    const removed = await app.call(
      "conversations.remove_person",
      { params: { conversationId, userId: ids.outsider } },
      as("creator")
    );
    expect(removed.statusCode, removed.body).toBe(200);
    const [followUp] = await withTestSql(
      (sql) => sql`select status from conversation_follow_ups where id = 'fu_outside'`
    );
    expect(followUp?.status).not.toBe("pending");
    expect((await read("outsider")).statusCode).toBe(404);

    // One who joins the team reads it as a member; when they leave the team, they lose it.
    expect((await share(app, conversationId, ids.outsider)).statusCode).toBe(200);
    const joined = await app.call(
      "workspaces.members.add",
      {
        params: { collaborationWorkspaceId: workspaceId },
        payload: { email: "outsider@example.test" }
      },
      as("owner")
    );
    expect(joined.statusCode, joined.body).toBe(200);
    expect((await read("outsider")).statusCode).toBe(200);
    const leftTeam = await app.call(
      "workspaces.members.leave",
      { params: { collaborationWorkspaceId: workspaceId } },
      as("outsider")
    );
    expect(leftTeam.statusCode, leftTeam.body).toBe(200);
    expect((await read("outsider")).statusCode).toBe(404);

    // The creator leaving the team leaves the outside reader's access as it is; nobody names
    // others until the creator returns.
    expect((await share(app, conversationId, ids.outsider)).statusCode).toBe(200);
    const creatorLeft = await app.call(
      "workspaces.members.leave",
      { params: { collaborationWorkspaceId: workspaceId } },
      as("creator")
    );
    expect(creatorLeft.statusCode, creatorLeft.body).toBe(200);
    expect((await read("outsider")).statusCode).toBe(200);
    expect((await share(app, conversationId, ids.colleague)).statusCode).toBe(404);
    expect(reasonOf(await share(app, conversationId, ids.colleague, "outsider"))).toBe(
      "share_creator_only"
    );

    // A personal call path after the share is refused: the chat is read by more than one.
    await expect(
      app.stores.conversations.markPersonalData({
        clientInstanceId,
        conversationId: asConversationId(conversationId),
        userId: ids.creator,
        at: new Date().toISOString()
      })
    ).rejects.toMatchObject({ details: { reason: "personal_connection_context" } });
    await app.close();
  });
});
