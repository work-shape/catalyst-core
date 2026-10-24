import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  createPlatformId,
  dataStoreOperationName,
  dataStoreRecordsFlaggedOutputSchema,
  type AuditEvent,
  type AuditRecorder,
  type AuthenticatedUser,
  type DataStoreOperationVerb,
  type JsonObject,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import { refusal, useDataStoreWorld } from "./support/data-store-world";
import {
  objektRecords,
  objektSchema,
  recordsActorOf,
  recordsWorlds
} from "./support/records-world";
import { accessOf } from "./support/access";
import { required } from "./support/assertions";

// REC-2, "Prüfen": the fields a person decides, the decision itself, and the one Inbox notice
// with a count. Acceptance check 86 of the Data Stores and Knowledge Bases spec.

const REVIEW_KIND = "data_store_review";

describe("REC-2 records review through the public operation source", () => {
  const dataStoreWorld = useDataStoreWorld("record_review");
  const { db, call } = dataStoreWorld;
  const { world } = recordsWorlds(dataStoreWorld);
  type World = Awaited<ReturnType<typeof world>>;

  /** One call as a given person, with the audit events it records. */
  async function callAs(
    w: World,
    actor: AuthenticatedUser,
    verb: DataStoreOperationVerb,
    input: unknown,
    origin: OperationOrigin = { kind: "user" }
  ) {
    const events: Parameters<AuditRecorder["record"]>[0][] = [];
    const audit: AuditRecorder = {
      record: (event) => {
        events.push(event);
        const recorded: AuditEvent = {
          ...event,
          id: createPlatformId<"AuditEventId">("aud"),
          clientInstanceId: asClientInstanceId(w.clientInstanceId),
          createdAt: new Date().toISOString()
        };
        return Promise.resolve(recorded);
      }
    };
    const operation = required(
      await w.dataStores.operationSource.resolve(dataStoreOperationName("findings", verb))
    );
    const output = await operation.execute(operation.inputSchema.parse(input), {
      runId: createPlatformId("opr"),
      actor,
      origin,
      correlationId: "records-review",
      runtime: {},
      access: accessOf(actor),
      audit
    });
    return { output, events };
  }

  /** A person who holds `data_store.records` and may use no Knowledge Base. */
  const reviewerOf = (w: World): AuthenticatedUser => ({
    id: "records-reviewer",
    externalUserId: "records-reviewer",
    displayLabel: "Records reviewer",
    roles: [],
    permissionRefs: [],
    permissions: ["data_store.records"],
    authSource: "test",
    clientInstanceId: asClientInstanceId(w.clientInstanceId)
  });

  const flagged = async (w: World, input: JsonObject = {}) =>
    dataStoreRecordsFlaggedOutputSchema.parse(
      await call(w, "records.flagged", { limit: 100, ...input })
    );

  const notices = (w: World) =>
    db.store.approvals.listApprovalRequests({
      clientInstanceId: w.clientInstanceId,
      kinds: [REVIEW_KIND],
      status: "pending"
    });

  it("check 86: a corrected Kaufpreis with its cited page beside it stays through a re-sync, and the audit names the field and no value", async () => {
    const w = await world("check86");
    const a = await w.item("a1", "kaufvertrag", { kaufpreis: 100 });
    const b = await w.item("b1", "kaufvertrag", { kaufpreis: 200 });
    await call(w, "records.propose", { table: "objekt", items: [a, b] }, "first");
    expect(await w.target`select kaufpreis from objekt`).toEqual([{ kaufpreis: null }]);

    const before = await flagged(w);
    expect(before.items).toHaveLength(2);
    expect(before.items).toEqual([
      expect.objectContaining({
        table: "objekt",
        key: 1402,
        name: "kaufpreis",
        value: 100,
        page: 1,
        quote: "100",
        documentId: "a1",
        reason: "conflict",
        document: { knowledgeBase: "unterlagen", fileName: "a1.pdf" }
      }),
      expect.objectContaining({ documentId: "b1", value: 200, reason: "conflict" })
    ]);

    const actor = recordsActorOf(w.clientInstanceId);
    const { output, events } = await callAs(w, actor, "records.decide", {
      table: "objekt",
      key: 1402,
      field: "kaufpreis",
      action: "correct",
      value: 150,
      knowledgeBaseId: w.kbId,
      documentId: "b1"
    });
    expect(output).toEqual({ decided: true });
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([{ kaufpreis: 150 }]);
    expect((await flagged(w)).items).toEqual([]);
    const decided = events.find((event) => event.type === "data_store.record_decided");
    expect(decided).toMatchObject({
      metadata: { store: "findings", table: "objekt", field: "kaufpreis", action: "correct" }
    });
    const text = JSON.stringify(decided);
    expect(text).not.toContain("150");
    expect(text).not.toContain("1402");

    // The next sync extracts both documents again: the correction is pinned.
    await call(w, "records.propose", { table: "objekt", items: [a, b] }, "resync");
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([{ kaufpreis: 150 }]);
    expect(
      await w.target`select document_id, state, decided_by from catalyst.record_fields order by document_id`
    ).toEqual([
      { document_id: "a1", state: "extracted", decided_by: null },
      { document_id: "b1", state: "corrected", decided_by: actor.id }
    ]);
    expect((await flagged(w)).items).toEqual([]);
  });

  it("asks a person to confirm a field the rule names, and confirms a value without evidence from its citation", async () => {
    const w = await world("confirm", [objektRecords(undefined, "[kaufpreis]"), objektSchema]);
    const item = await w.item("a2", "kaufvertrag", { kaufpreis: 100, baujahr: 1990 });
    item.fields[1] = { name: "baujahr", value: 1991, page: 1, quote: "1990" };
    await call(w, "records.propose", { table: "objekt", items: [item] });
    expect(await w.target`select kaufpreis, baujahr from objekt`).toEqual([
      { kaufpreis: null, baujahr: null }
    ]);
    expect((await flagged(w)).items.map(({ name, reason }) => ({ name, reason }))).toEqual([
      { name: "baujahr", reason: "not_evidenced" },
      { name: "kaufpreis", reason: "confirmation_required" }
    ]);

    // One value: no citation needed.
    await call(w, "records.decide", {
      table: "objekt",
      key: "1402",
      field: "kaufpreis",
      action: "confirm"
    });
    await call(w, "records.decide", {
      table: "objekt",
      key: 1402,
      field: "baujahr",
      action: "confirm",
      knowledgeBaseId: w.kbId,
      documentId: "a2"
    });
    expect(await w.target`select kaufpreis::float8, baujahr from objekt`).toEqual([
      { kaufpreis: 100, baujahr: 1991 }
    ]);
    expect((await flagged(w)).items).toEqual([]);
  });

  it("refuses an unclear decision, a value its column does not take and a field the object lacks, each named", async () => {
    const w = await world("refusals");
    await call(w, "records.propose", {
      table: "objekt",
      items: [
        await w.item("a3", "kaufvertrag", { kaufpreis: 100 }),
        await w.item("b3", "kaufvertrag", { kaufpreis: 200 })
      ]
    });
    const decide = (input: JsonObject) =>
      refusal(
        call(w, "records.decide", { table: "objekt", key: 1402, field: "kaufpreis", ...input })
      );
    expect(await decide({ action: "confirm" })).toMatchObject({
      details: { reason: "record_citation_required" }
    });
    expect(await decide({ action: "correct", value: "teuer" })).toMatchObject({
      details: { reason: "record_field_unknown" }
    });
    expect(await decide({ action: "confirm", field: "baujahr" })).toMatchObject({
      code: "NOT_FOUND",
      details: { reason: "record_field_unknown" }
    });
    expect(await decide({ action: "confirm", key: "kein-schluessel" })).toMatchObject({
      details: { reason: "record_key_invalid" }
    });
    expect(await w.target`select kaufpreis from objekt`).toEqual([{ kaufpreis: null }]);
  });

  it("assigns a document whose object was not known, and writes its fields into that object", async () => {
    const w = await world("assign");
    const lost = await w.item(
      "e4",
      "expose",
      { adresse: "Nebenweg 1", wohnflaeche: 80 },
      "2026-10-18",
      "/Other/file.pdf"
    );
    await call(w, "records.propose", { table: "objekt", items: [lost] });
    expect(await w.target`select count(*)::int as n from objekt`).toEqual([{ n: 0 }]);
    const waiting = await flagged(w);
    expect(waiting.items.map(({ key, name, reason }) => ({ key, name, reason }))).toEqual([
      { key: null, name: "adresse", reason: "key_unresolved" },
      { key: null, name: "wohnflaeche", reason: "key_unresolved" }
    ]);
    await call(w, "records.decide", {
      table: "objekt",
      key: 1403,
      field: "adresse",
      action: "assign",
      knowledgeBaseId: w.kbId,
      documentId: "e4"
    });
    expect(await w.target`select objekt_nr, adresse, wohnflaeche::float8 from objekt`).toEqual([
      { objekt_nr: 1403, adresse: "Nebenweg 1", wohnflaeche: 80 }
    ]);
    expect((await flagged(w)).items).toEqual([]);
    expect(
      await refusal(
        call(w, "records.decide", {
          table: "objekt",
          key: 1403,
          field: "adresse",
          action: "assign",
          knowledgeBaseId: w.kbId,
          documentId: "e4"
        })
      )
    ).toMatchObject({ code: "NOT_FOUND" });
  });

  it("pages through flagged candidates with a cursor and refuses a cursor it did not give out", async () => {
    const w = await world("paging");
    const items = [];
    for (const [n, price] of [100, 200, 300].entries())
      items.push(
        await w.item(`p${n}`, "kaufvertrag", { kaufpreis: price }, "2026-10-17", "/Objekte/7/x.pdf")
      );
    items.push(
      await w.item("q0", "kaufvertrag", { kaufpreis: 1 }, "2026-10-17", "/Objekte/8/x.pdf"),
      await w.item("q1", "kaufvertrag", { kaufpreis: 2 }, "2026-10-17", "/Objekte/8/x.pdf")
    );
    await call(w, "records.propose", { table: "objekt", items });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await flagged(w, { limit: 2, ...(cursor ? { cursor } : {}) });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.documentId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["p0", "p1", "p2", "q0", "q1"]);
    expect(await refusal(flagged(w, { cursor: "bm90LWEtY3Vyc29y" }))).toMatchObject({
      code: "VALIDATION_FAILED"
    });
  });

  it("shows a candidate only to a reader who may use its Knowledge Base, and refuses a decision citing it", async () => {
    const w = await world("citations");
    await call(w, "records.propose", {
      table: "objekt",
      items: [
        await w.item("a5", "kaufvertrag", { kaufpreis: 100 }),
        await w.item("b5", "kaufvertrag", { kaufpreis: 200 })
      ]
    });
    const reviewer = reviewerOf(w);
    const { output } = await callAs(w, reviewer, "records.flagged", { limit: 100 });
    expect(output).toEqual({ items: [] });
    expect(
      await refusal(
        callAs(w, reviewer, "records.decide", {
          table: "objekt",
          key: 1402,
          field: "kaufpreis",
          action: "confirm",
          knowledgeBaseId: w.kbId,
          documentId: "a5"
        })
      )
    ).toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a decision without a citation that pins a candidate of a Knowledge Base the person may not use", async () => {
    const w = await world("uncited");
    await call(w, "records.propose", {
      table: "objekt",
      items: [await w.item("a7", "kaufvertrag", { kaufpreis: 100 })]
    });
    const decide = (input: JsonObject) =>
      refusal(
        callAs(w, reviewerOf(w), "records.decide", {
          table: "objekt",
          key: 1402,
          field: "kaufpreis",
          ...input
        })
      );
    expect(await decide({ action: "correct", value: 150 })).toMatchObject({ code: "FORBIDDEN" });
    expect(await decide({ action: "confirm" })).toMatchObject({ code: "FORBIDDEN" });
    expect(await w.target`select document_id, state from catalyst.record_fields`).toEqual([
      { document_id: "a7", state: "extracted" }
    ]);
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([{ kaufpreis: 100 }]);
  });

  it("takes a decision only from a person: a Workflow step that may propose the field is refused", async () => {
    const w = await world("person", [objektRecords(undefined, "[kaufpreis]"), objektSchema]);
    await call(w, "records.propose", {
      table: "objekt",
      items: [await w.item("a8", "kaufvertrag", { kaufpreis: 100 })]
    });
    const input = { table: "objekt", key: 1402, field: "kaufpreis", action: "confirm" };
    const actor = recordsActorOf(w.clientInstanceId);
    for (const origin of [
      { kind: "workflow", workflowRunId: "records-run", stepRunId: "step-1" },
      { kind: "schedule", scheduleId: "nightly" }
    ] satisfies OperationOrigin[])
      expect(await refusal(callAs(w, actor, "records.decide", input, origin))).toMatchObject({
        code: "FORBIDDEN",
        details: { reason: "record_decision_person_required" }
      });
    expect(await w.target`select kaufpreis from objekt`).toEqual([{ kaufpreis: null }]);
    await callAs(w, actor, "records.decide", input, { kind: "cli" });
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([{ kaufpreis: 100 }]);
  });

  it("leaves out the candidate of a withdrawn document, its quote included", async () => {
    const w = await world("withdrawn");
    await call(w, "records.propose", {
      table: "objekt",
      items: [
        await w.item("a9", "kaufvertrag", { kaufpreis: 100 }),
        await w.item("b9", "kaufvertrag", { kaufpreis: 200 })
      ]
    });
    expect((await flagged(w)).items.map((item) => item.documentId)).toEqual(["a9", "b9"]);
    await w.source`update catalyst_kb.documents set withdrawn_at = now() where id = 'b9'`;
    const after = await flagged(w);
    expect(after.items.map((item) => item.documentId)).toEqual(["a9"]);
    // Its id, its file and its quote; quoted, since a random id may hold the letters "b9".
    for (const left of ['"b9"', '"b9.pdf"', '"200"'])
      expect(JSON.stringify(after)).not.toContain(left);
  });

  it("never counts a correction that a later decision replaced as read from its document", async () => {
    const w = await world("replaced");
    await call(w, "records.propose", {
      table: "objekt",
      items: [
        await w.item("a10", "kaufvertrag", { kaufpreis: 100 }),
        await w.item("b10", "kaufvertrag", { kaufpreis: 200 })
      ]
    });
    const base = { table: "objekt", key: 1402, field: "kaufpreis", knowledgeBaseId: w.kbId };
    await call(w, "records.decide", { ...base, action: "correct", value: 150, documentId: "b10" });
    await call(w, "records.decide", { ...base, action: "confirm", documentId: "a10" });
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([{ kaufpreis: 100 }]);
    expect(
      await w.target`select document_id, value, state, evidence from catalyst.record_fields order by document_id`
    ).toEqual([
      { document_id: "a10", value: 100, state: "confirmed", evidence: { status: "passed" } },
      {
        document_id: "b10",
        value: 150,
        state: "extracted",
        evidence: { status: "failed", reason: "value_not_parsed" }
      }
    ]);
    // Without the confirmed candidate, the person's old value is not written as read from b10.
    await w.target`delete from catalyst.record_fields where document_id = 'a10'`;
    await call(w, "records.propose", {
      table: "objekt",
      items: [await w.item("c10", "expose", { baujahr: 1990 })]
    });
    expect(await w.target`select kaufpreis from objekt`).toEqual([{ kaufpreis: null }]);
    expect(
      (await flagged(w)).items.map(({ documentId, reason }) => ({ documentId, reason }))
    ).toEqual([{ documentId: "b10", reason: "not_evidenced" }]);
  });

  it("files one Inbox notice per store whose count is what waits now, not one per field or proposal", async () => {
    const w = await world("notice");
    await call(w, "records.propose", {
      table: "objekt",
      items: [await w.item("a6", "kaufvertrag", { kaufpreis: 100, baujahr: 1990 })]
    });
    expect(await notices(w)).toEqual([]);
    await call(w, "records.propose", {
      table: "objekt",
      items: [await w.item("b6", "kaufvertrag", { kaufpreis: 200, baujahr: 1991 })]
    });
    await call(w, "records.propose", {
      table: "objekt",
      items: [
        await w.item("e6", "expose", { adresse: "Nebenweg 2" }, "2026-10-18", "/Other/file.pdf")
      ]
    });
    const [notice, ...more] = await notices(w);
    expect(more).toEqual([]);
    expect(notice).toMatchObject({
      kind: REVIEW_KIND,
      payload: { subject: { dataStoreId: w.id, store: "findings" } }
    });
    expect(JSON.stringify(notice)).not.toContain("1402");
    const handler = w.dataStores.reviewNotice;
    const preview = () =>
      handler.preview(handler.validate(required(notice).payload), {
        clientInstanceId: w.clientInstanceId,
        requestId: required(notice).id,
        correlationId: "records-review"
      });
    // Two fields in conflict and one unassigned field.
    expect(await preview()).toMatchObject({ store: "findings", title: "Findings", flagged: 3 });
    await call(w, "records.decide", {
      table: "objekt",
      key: 1402,
      field: "baujahr",
      action: "confirm",
      knowledgeBaseId: w.kbId,
      documentId: "a6"
    });
    expect(await preview()).toMatchObject({ flagged: 2 });
  });
});
