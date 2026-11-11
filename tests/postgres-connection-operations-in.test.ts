import { describe, expect, it } from "vitest";
import {
  createPlatformId,
  type ConversationId,
  type OperationRunEnd
} from "@work-shape/catalyst-core";
import { usePostgresSuite } from "./support/postgres-suite";
import { createSubagentFixture } from "./support/subagent-runs";

// The Connection operations that ran in a chat and in every run thread under it (PMCP-4, the
// cross-source rule of a person's own server): what the floor of its reads asks. A call that
// waited, was refused or never executed did not run.

describe("Postgres Connection operations of a conversation", () => {
  const db = usePostgresSuite("connection_ops_in");

  it("names each operation once, of the chat and of every thread under it, and of no other", async () => {
    const fixture = await createSubagentFixture(db, "tree");
    const root = await fixture.createConversation("chat");
    const other = await fixture.createConversation("another chat");
    const parent = await fixture.startParent(root);
    const child = await fixture.startChild(parent.run, "child");
    const sibling = await fixture.startChild(parent.run, "sibling");
    const now = new Date().toISOString();
    const record = async (
      operation: string,
      conversationId: ConversationId,
      end?: OperationRunEnd
    ) => {
      const run = await db.store.operationRuns.create({
        id: createPlatformId("oprun"),
        clientInstanceId: fixture.clientInstanceId,
        operation,
        effect: "reading",
        actor: { kind: "user", id: "author", label: "Author" },
        origin: { kind: "user" },
        conversationId,
        target: "live",
        inputHash: createPlatformId("hash"),
        correlationId: "corr_ops_in",
        startedAt: now
      });
      if (!run) throw new Error("No run was created");
      if (end) {
        await db.store.operationRuns.finish({
          clientInstanceId: fixture.clientInstanceId,
          id: run.id,
          end
        });
      }
    };
    const ran = (conversationId: ConversationId) =>
      db.store.operationRuns
        .connectionOperationsIn({ clientInstanceId: fixture.clientInstanceId, conversationId })
        .then((names) => [...names].sort());

    expect(await ran(root.id)).toEqual([]);

    await record("connection.notes.search", root.id, { status: "done", finishedAt: now });
    await record("connection.notes.search", root.id, { status: "done", finishedAt: now });
    // Running counts: the call reached the system.
    await record("connection.crm.lookup", child.threadId);
    await record("connection.mail.read", sibling.threadId, {
      status: "failed",
      finishedAt: now,
      error: { code: "INTERNAL", message: "The system failed" }
    });
    // A call that waits, that was refused, or that never executed did not run.
    await record("connection.waiting.change", root.id, {
      status: "pending_confirmation",
      finishedAt: now,
      expiresAt: "2999-01-01T00:00:00.000Z"
    });
    await record("connection.refused.read", root.id, {
      status: "denied",
      finishedAt: now,
      error: { code: "FORBIDDEN", message: "Refused" },
      denial: { kind: "policy", operation: "connection.refused.read" }
    });
    await record("connection.unexecuted.read", child.threadId, {
      status: "failed",
      finishedAt: now,
      error: { code: "CONFLICT", message: "Never executed", unexecuted: true }
    });
    // Not a Connection's, and not this chat's.
    await record("agents.run", root.id, { status: "done", finishedAt: now });
    await record("connection.elsewhere.read", other.id, { status: "done", finishedAt: now });

    expect(await ran(root.id)).toEqual([
      "connection.crm.lookup",
      "connection.mail.read",
      "connection.notes.search"
    ]);
    // A thread alone is not its chat.
    expect(await ran(child.threadId)).toEqual(["connection.crm.lookup"]);
    expect(await ran(other.id)).toEqual(["connection.elsewhere.read"]);
    // Another instance reads nothing of this one.
    expect(
      await db.store.operationRuns.connectionOperationsIn({
        clientInstanceId: db.clientInstance("other"),
        conversationId: root.id
      })
    ).toEqual([]);
  });
});
