import { describe, expect, it } from "vitest";
import { asAgentRunId } from "@work-shape/catalyst-core";
import { required, waitUntil } from "./support/assertions";
import { followUpFixture as fixture } from "./support/follow-up-fixture";
import { withTestSql } from "./support/test-sql";

describe("server follow-up queue scheduling at scale", () => {
  // Repeat with fresh instances to exercise both queue/worker scheduling orders.
  it.each([2, 3, 4, 5, 6])(
    "streams 64 deltas through concurrent queue edits, withdrawal and completion without sequence gaps or deadlocks (repetition %i)",
    async () => {
      const f = await fixture(false, { streaming: true });
      const observations = (id = f.first.run.id) =>
        f.app.stores.agentRuns.listRunObservations({
          clientInstanceId: f.scope.clientInstanceId,
          runId: asAgentRunId(id)
        });
      const streamed = async (count: number) =>
        waitUntil(
          async () =>
            (await observations()).filter((event) => event.type === "message_delta").length >=
            count,
          `${count} deltas reached observers`
        );
      await streamed(1);
      const [original] = await Promise.all([
        f.queue("Original"),
        Promise.resolve().then(() => f.advance())
      ]);
      await streamed(17);
      const withdraw = () =>
        f.app.call("conversations.follow_ups.withdraw", {
          params: { conversationId: f.scope.conversationId, followUpId: original.id },
          payload: {}
        });
      const [edited, withdrawn] = await Promise.all([
        f.queue("Edited"),
        withdraw(),
        Promise.resolve().then(() => f.advance())
      ]);
      expect(withdrawn.statusCode, withdrawn.body).toBe(200);
      await streamed(33);
      const disposable = await f.queue("Withdraw during a write");
      await f.app.stores.transaction(async (stores) => {
        // Hold exactly the conversation lock that queue acceptance/editing holds.
        await stores.followUps.getOldestPending(f.scope);
        f.advance();
        await waitUntil(
          async () =>
            (
              await withTestSql(
                (sql) => sql`
          select pid from pg_stat_activity where datname = current_database()
            and wait_event_type = 'Lock'
            and (query ilike '%conversations%' or query ilike '%agent_run_observations%')
        `
              )
            ).length > 0,
          "worker waits on the held conversation"
        );
        // With the old order the worker already owns the run row: this write causes 40P01.
        await stores.followUps.cancel({
          ...f.scope,
          followUpId: disposable.id,
          authorUserId: f.author.id
        });
      });
      await streamed(49);
      f.advance();
      await streamed(65);
      f.release();
      await f.until(f.first.run.id, "completed");
      await f.dispatch();
      const dispatched = required(
        await f.app.stores.followUps.get({ ...f.scope, followUpId: edited.id })
      );
      expect(dispatched.status).toBe("dispatched");
      const nextId = required(dispatched.dispatchedRunId);
      // Finish the dispatched turn too; its first observation may be follow_up_changed.
      await waitUntil(
        async () => (await observations(nextId)).some((event) => event.type === "message_delta"),
        "follow-up streams"
      );
      for (let batch = 0; batch < 4; batch++) {
        f.advance();
        await waitUntil(
          async () =>
            (await observations(nextId)).filter((event) => event.type === "message_delta").length >=
            1 + (batch + 1) * 16,
          "follow-up batch persisted"
        );
      }
      await f.complete(nextId, 1);
      for (const id of [f.first.run.id, nextId]) {
        const events = await observations(id);
        expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
        expect(events.map((event) => event.payload.sequence)).toEqual(
          events.map((event) => event.sequence)
        );
        expect(events.at(-1)?.type).toBe("run_completed");
      }
      expect(
        (await observations())
          .filter((event) => event.type === "follow_up_changed")
          .map((event) => event.payload)
      ).toEqual(
        expect.arrayContaining(
          [
            { followUp: { id: original.id, status: "pending" } },
            { followUp: { id: edited.id, status: "pending" } },
            { followUp: { id: original.id, status: "cancelled" } },
            { followUp: { id: disposable.id, status: "pending" } },
            { followUp: { id: disposable.id, status: "cancelled" } }
          ].map((event) =>
            expect.objectContaining({ followUp: expect.objectContaining(event.followUp) })
          )
        )
      );
      expect(
        (await f.messages())
          .filter((message) => message.role === "user")
          .map((message) => message.text)
      ).toEqual(["First", "Edited"]);
    }
  );
});
