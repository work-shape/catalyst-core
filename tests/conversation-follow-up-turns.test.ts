import { describe, expect, it } from "vitest";
import { createPlatformId } from "@work-shape/catalyst-core";
import { followUpFixture as fixture } from "./support/follow-up-fixture";
import { required, waitUntil } from "./support/assertions";
import { withTestSql } from "./support/test-sql";

describe("merged follow-up turns on Postgres", () => {
  it("merges compatible messages once, retaining transcript order, model input, per-message attachments and audits", async () => {
    const f = await fixture(false, { attachments: true });
    const firstAttachment = await f.attachment(true);
    const one = await f.queue("Merged one", "author", "merged-one");
    const secondAttachment = await f.attachment(true);
    const two = await f.queue("Merged two");
    const three = await f.queue("Merged three");
    const nextDraft = await f.attachment();
    await f.complete();
    await f.dispatch();
    expect(await f.pending()).toEqual([]);
    const dispatched = await Promise.all(
      [one, two, three].map((item) =>
        f.app.stores.followUps.get({ ...f.scope, followUpId: item.id })
      )
    );
    const runId = required(required(dispatched[0]).dispatchedRunId);
    expect(dispatched).toEqual(
      dispatched.map((item) =>
        expect.objectContaining({
          status: "dispatched",
          dispatchedRunId: runId,
          id: required(item).id
        })
      )
    );
    await waitUntil(async () => f.modelInputs.length === 2, "one merged model call started");
    const messages = (await f.messages()).filter((message) => message.role === "user");
    expect(messages.map((message) => message.text)).toEqual([
      "First",
      "Merged one",
      "Merged two",
      "Merged three"
    ]);
    expect(await f.run(runId)).toMatchObject({
      inputMessageId: required(messages.at(-1)).id,
      ownerUserId: f.author.id,
      agentName: one.agentName,
      modelBindingId: one.modelBindingId,
      reasoningEffort: one.reasoningEffort
    });
    const input = JSON.stringify(required(f.modelInputs[1]).messages);
    for (const text of ["Merged one", "Merged two", "Merged three"]) expect(input).toContain(text);
    expect(input.indexOf("Merged one")).toBeLessThan(input.indexOf("Merged two"));
    expect(input.indexOf("Merged two")).toBeLessThan(input.indexOf("Merged three"));
    for (const [index, attachment] of [firstAttachment, secondAttachment].entries()) {
      const message = required(messages[index + 1]);
      expect(JSON.stringify(message.metadata)).toContain(attachment.id);
      expect(
        await f.app.stores.files.getConversationAttachment({
          clientInstanceId: f.scope.clientInstanceId,
          attachmentId: attachment.id
        })
      ).toMatchObject({ messageId: message.id });
    }
    expect(await f.app.stores.files.listDraftAttachments(f.scope)).toMatchObject([
      { id: nextDraft.id }
    ]);
    const queuedMessageIds = messages.slice(1).map((message) => message.id);
    const audits = await withTestSql(
      (sql) =>
        sql`select subject, metadata from audit_events where subject in ${sql(queuedMessageIds)} and type = 'message.created'`
    );
    expect(audits).toHaveLength(3);
    expect(audits.map((row) => row.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ delivery: "queued", attachmentCount: 1 }),
        expect.objectContaining({ delivery: "queued", attachmentCount: 0 })
      ])
    );
    expect(JSON.stringify(audits)).not.toContain("Merged one");
    expect(await f.queue("Merged one", "author", "merged-one")).toMatchObject({
      id: one.id,
      status: "dispatched",
      dispatchedRunId: runId
    });
    await f.dispatch();
    expect((await f.messages()).filter((message) => message.role === "user")).toHaveLength(4);
    await f.complete(runId, 1);
    await f.dispatch();
    expect(f.modelInputs).toHaveLength(2);
  });

  it.each(["author", "agent", "model", "effort", "credential"] as const)(
    "stops at a different %s and never skips it to merge a later matching message",
    async (difference) => {
      const f = await fixture();
      const one = await f.queue("Head");
      const two = await f.queue("Boundary");
      const three = await f.queue("Later match");
      await withTestSql(async (sql) => {
        if (difference === "author")
          await sql`update conversation_follow_ups set author_user_id = ${f.other.id} where id = ${two.id}`;
        if (difference === "agent")
          await sql`update conversation_follow_ups set agent_name = 'other_agent' where id = ${two.id}`;
        if (difference === "model")
          await sql`update conversation_follow_ups set model_binding_id = 'first' where id = ${two.id}`;
        if (difference === "effort")
          await sql`update conversation_follow_ups set reasoning_effort = null where id = ${two.id}`;
        if (difference === "credential")
          await sql`update conversation_follow_ups set authorization_context = jsonb_set(authorization_context, '{scopes}', '["run:start"]'::jsonb) where id = ${two.id}`;
      });
      await f.complete();
      await f.dispatch();
      expect((await f.pending()).map((item) => item.id)).toEqual([two.id, three.id]);
      expect(await f.app.stores.followUps.get({ ...f.scope, followUpId: one.id })).toMatchObject({
        status: "dispatched"
      });
      expect(
        (await f.messages())
          .filter((message) => message.role === "user")
          .map((message) => message.text)
      ).toEqual(["First", "Head"]);
    }
  );

  it("merges null optional selections and ignores withdrawn rows without crossing a pending boundary", async () => {
    const f = await fixture();
    const one = await f.queue("Null one");
    const withdrawn = await f.queue("Withdrawn", "other");
    const two = await f.queue("Null two");
    const response = await f.app.call(
      "conversations.follow_ups.withdraw",
      {
        params: { conversationId: f.scope.conversationId, followUpId: withdrawn.id },
        payload: {}
      },
      "other"
    );
    expect(response.statusCode, response.body).toBe(200);
    await withTestSql(
      (sql) =>
        sql`update conversation_follow_ups set model_binding_id = null, reasoning_effort = null where id in ${sql([one.id, two.id])}`
    );
    await f.complete();
    await f.dispatch();
    expect(await f.pending()).toEqual([]);
    expect(
      (await f.messages())
        .filter((message) => message.role === "user")
        .map((message) => message.text)
    ).toEqual(["First", "Null one", "Null two"]);
  });
  it("reads a compatible turn within one second among 10,000 retained follow-ups using the pending index", async () => {
    const f = await fixture(true);
    const items = [await f.queue("One"), await f.queue("Two"), await f.queue("Three")];
    await withTestSql(async (sql) => {
      await sql`insert into conversation_follow_ups
        (id, client_instance_id, conversation_id, author_user_id, text, mode, status, position, agent_name, created_at, updated_at)
        select ${createPlatformId("capacity")} || '-' || n, ${f.scope.clientInstanceId}, ${f.scope.conversationId}, ${f.author.id}, 'Ended', 'queue', 'dispatched', n, 'test_agent', now(), now()
        from generate_series(4, 10000) n`;
      await sql`analyze conversation_follow_ups`;
      const plan =
        await sql`explain (analyze, format json) select position from conversation_follow_ups
        where client_instance_id = ${f.scope.clientInstanceId} and conversation_id = ${f.scope.conversationId}
          and status = 'pending' and position > 1 and model_binding_id is distinct from 'picked'
        order by position limit 1`;
      expect(JSON.stringify(plan)).toContain("conversation_follow_ups_pending_idx");
    });
    const started = performance.now();
    const turn = await f.app.stores.followUps.getPendingTurn(f.scope);
    expect(turn.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
