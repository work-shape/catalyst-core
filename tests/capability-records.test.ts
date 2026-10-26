import { createPlatformId, type OperationRunId } from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import { capabilityStoresOf } from "@work-shape/catalyst-client-assembly";
import { usePostgresSuite } from "./support/postgres-suite";

// ADR-0033: a capability keeps working state in `capability_records`, reaches only its own
// rows, and ends only the Operation Runs of its own operations.

const at = "2026-10-26T10:00:00.000Z";

describe("capability records", () => {
  const db = usePostgresSuite("capability_records");

  function portsOf(label: string, capability = "forms", operations = ["forms.request"]) {
    const clientInstanceId = db.clientInstance(label);
    return {
      clientInstanceId,
      ...capabilityStoresOf({
        clientInstanceId,
        capability,
        store: db.store,
        operations: () => new Set(operations)
      })
    };
  }

  it("creates, finds by key, and refuses a taken id or key", async () => {
    const { records } = portsOf("create");
    const created = await records.create({
      kind: "form",
      id: "f1",
      key: "hash-1",
      status: "open",
      document: { title: "Aufnahme" },
      at
    });
    expect(created).toMatchObject({ id: "f1", key: "hash-1", status: "open", version: 1 });
    await expect(records.getByKey({ kind: "form", key: "hash-1" })).resolves.toMatchObject({
      id: "f1",
      document: { title: "Aufnahme" }
    });
    await expect(
      records.create({ kind: "form", id: "f1", status: "open", document: {}, at })
    ).resolves.toBeUndefined();
    await expect(
      records.create({ kind: "form", id: "f2", key: "hash-1", status: "open", document: {}, at })
    ).resolves.toBeUndefined();
  });

  it("changes a record only as the caller read it", async () => {
    const { records } = portsOf("update");
    await records.create({ kind: "form", id: "f1", status: "open", document: { a: 1 }, at });
    const changed = await records.update({
      kind: "form",
      id: "f1",
      version: 1,
      document: { a: 2 },
      at
    });
    expect(changed).toMatchObject({ version: 2, document: { a: 2 } });
    await expect(
      records.update({ kind: "form", id: "f1", version: 1, status: "submitted", at })
    ).resolves.toBeUndefined();
    await expect(records.get({ kind: "form", id: "f1" })).resolves.toMatchObject({
      status: "open",
      version: 2
    });
  });

  it("gives each claim other records and answers them as they were", async () => {
    const { records } = portsOf("claim");
    for (const id of ["a", "b", "c"])
      await records.create({ kind: "code", id, status: "pending", document: { id }, at });
    const [first, second] = await Promise.all([
      records.claim({ kind: "code", status: "pending", toStatus: "sent", limit: 2, at }),
      records.claim({ kind: "code", status: "pending", toStatus: "sent", limit: 2, at })
    ]);
    const ids = [...first, ...second].map((record) => record.id);
    // No record goes to both claims, and each one claimed has moved.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(first[0]).toMatchObject({ status: "pending", version: 1 });
    for (const id of ids)
      await expect(records.get({ kind: "code", id })).resolves.toMatchObject({ status: "sent" });
  });

  it("claims only what expires before a moment, and deletes what expired", async () => {
    const { records } = portsOf("expiry");
    await records.create({
      kind: "form",
      id: "old",
      status: "open",
      document: {},
      expiresAt: "2026-10-01T00:00:00.000Z",
      at
    });
    await records.create({
      kind: "form",
      id: "new",
      status: "open",
      document: {},
      expiresAt: "2026-11-30T00:00:00.000Z",
      at
    });
    const expired = await records.claim({
      kind: "form",
      status: "open",
      toStatus: "expired",
      limit: 10,
      expiresBefore: at,
      at
    });
    expect(expired.map((record) => record.id)).toEqual(["old"]);
    await expect(records.deleteExpired({ before: at })).resolves.toBe(1);
    await expect(records.get({ kind: "form", id: "old" })).resolves.toBeUndefined();
  });

  it("keeps one capability's records from another", async () => {
    const forms = portsOf("isolation");
    const other = capabilityStoresOf({
      clientInstanceId: forms.clientInstanceId,
      capability: "other",
      store: db.store,
      operations: () => new Set()
    });
    await forms.records.create({
      kind: "form",
      id: "f1",
      key: "k",
      status: "open",
      document: {},
      at
    });
    await expect(other.records.get({ kind: "form", id: "f1" })).resolves.toBeUndefined();
    await expect(other.records.getByKey({ kind: "form", key: "k" })).resolves.toBeUndefined();
    await expect(other.records.deleteExpired({ before: "2100-01-01T00:00:00.000Z" })).resolves.toBe(
      0
    );
  });

  it("ends a running run of its own operation and refuses another's", async () => {
    const { clientInstanceId, operationRuns } = portsOf("runs");
    async function running(operation: string): Promise<OperationRunId> {
      const id = createPlatformId<"OperationRunId">("oprun");
      const created = await db.store.operationRuns.create({
        id,
        clientInstanceId,
        operation,
        effect: "changing",
        target: "live",
        actor: { kind: "user", id: "u1", label: "Author" },
        origin: { kind: "cli" },
        inputHash: "a".repeat(64),
        correlationId: `corr_${id}`,
        startedAt: at
      });
      expect(created).toBeDefined();
      return id;
    }
    const own = await running("forms.request");
    const foreign = await running("mail.send");
    await expect(operationRuns.get(foreign)).resolves.toBeUndefined();
    await expect(
      operationRuns.finish({
        id: foreign,
        end: { status: "done", finishedAt: at, output: { value: {} } }
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      operationRuns.finish({
        id: own,
        end: { status: "done", finishedAt: at, output: { value: { answers: {} } } }
      })
    ).resolves.toMatchObject({ status: "done" });
  });
});
