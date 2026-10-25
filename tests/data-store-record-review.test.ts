import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  asUserId,
  createPlatformId,
  dataStoreOperationName,
  dataStoreRecordsFlaggedOutputSchema,
  type AuditEvent,
  type AuditRecorder,
  type ActorAccess,
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
import { groupFlagged } from "@work-shape/catalyst-chat-ui/build-area";
import { accessOf } from "./support/access";
import { required } from "./support/assertions";

// REC-2, "Prüfen": the fields a person decides, the decision itself, and the one Inbox notice
// with a count. Acceptance check 86 of the Data Stores and Knowledge Bases spec.

const REVIEW_KIND = "data_store_review";

/** No field of the record holds one of the values, as a number or as text. Not a substring of the
 * JSON: a random id or timestamp may contain the digits. */
function expectNoField(record: unknown, ...values: number[]): void {
  const leaves: unknown[] = [];
  const walk = (node: unknown): void => {
    if (node !== null && typeof node === "object") Object.values(node).forEach(walk);
    else leaves.push(node);
  };
  walk(record);
  for (const value of values) {
    expect(leaves).not.toContain(value);
    expect(leaves).not.toContain(String(value));
  }
}

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
    origin: OperationOrigin = { kind: "user" },
    access: ActorAccess = accessOf(actor)
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
      access,
      audit
    });
    return { output, events };
  }

  /** A person who holds `data_store.records` and may use no Knowledge Base. */
  const reviewerOf = (w: World, id = "records-reviewer"): AuthenticatedUser => ({
    id,
    externalUserId: id,
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
    // Neither the value nor the row key is a field of the record. Compared by field, since a
    // random id or timestamp may hold the digits.
    expectNoField(decided, 150, 1402);

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

  it("check 114: replacing a correction leaves the candidate as its document reads it, evidence passed, and counted as read again", async () => {
    const w = await world("replaced");
    await call(w, "records.propose", {
      table: "objekt",
      items: [
        await w.item("a10", "kaufvertrag", { kaufpreis: 1_210_000 }),
        await w.item("b10", "kaufvertrag", { kaufpreis: 1_250_000 })
      ]
    });
    const base = { table: "objekt", key: 1402, field: "kaufpreis", knowledgeBaseId: w.kbId };
    await call(w, "records.decide", {
      ...base,
      action: "correct",
      value: 1_205_000,
      documentId: "b10"
    });
    await call(w, "records.decide", { ...base, action: "confirm", documentId: "a10" });
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([
      { kaufpreis: 1_210_000 }
    ]);
    expect(
      await w.target`select document_id, value, corrected_value, state, evidence from catalyst.record_fields order by document_id`
    ).toEqual([
      {
        document_id: "a10",
        value: 1_210_000,
        corrected_value: null,
        state: "confirmed",
        evidence: { status: "passed" }
      },
      {
        document_id: "b10",
        value: 1_250_000,
        corrected_value: null,
        state: "extracted",
        evidence: { status: "passed" }
      }
    ]);
    // Without the confirmed candidate, b10 is what its document reads, and wins as such.
    await w.target`delete from catalyst.record_fields where document_id = 'a10'`;
    await call(w, "records.propose", {
      table: "objekt",
      items: [await w.item("c10", "expose", { baujahr: 1990 })]
    });
    expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([
      { kaufpreis: 1_250_000 }
    ]);
    expect((await flagged(w)).items).toEqual([]);
  });

  describe("check 114: a correction keeps the value its document reads", () => {
    /**
     * a12 reads 1.250.000 and a person corrects it to 1.205.000. b12 is pinned beside it by hand,
     * at `pinned`, standing for a second decided candidate, and c12 is one more proposal, so the
     * field is projected again with both pinned candidates as peers.
     */
    async function corrected(label: string, pinned: number) {
      const w = await world(label);
      await call(w, "records.propose", {
        table: "objekt",
        items: [await w.item("a12", "kaufvertrag", { kaufpreis: 1_250_000 })]
      });
      const actor = recordsActorOf(w.clientInstanceId);
      const { events } = await callAs(w, actor, "records.decide", {
        table: "objekt",
        key: 1402,
        field: "kaufpreis",
        action: "correct",
        value: 1_205_000,
        knowledgeBaseId: w.kbId,
        documentId: "a12"
      });
      const pin = async () => {
        await call(w, "records.propose", {
          table: "objekt",
          items: [await w.item("b12", "kaufvertrag", { kaufpreis: pinned })]
        });
        await w.target`update catalyst.record_fields
          set state = 'confirmed', decided_by = 'records-other', decided_at = now()
          where document_id = 'b12'`;
        await call(w, "records.propose", {
          table: "objekt",
          items: [await w.item("c12", "kaufvertrag", { kaufpreis: 1_300_000 })]
        });
      };
      return { w, actor, events, pin };
    }

    it("projects the corrected value, keeps the value read with its evidence, and audits neither", async () => {
      const { w, actor, events } = await corrected("keep-projected", 1_205_000);
      expect(await w.target`select kaufpreis::float8 from objekt`).toEqual([
        { kaufpreis: 1_205_000 }
      ]);
      expect(
        await w.target`select value, corrected_value, evidence, state, decided_by from catalyst.record_fields`
      ).toEqual([
        {
          value: 1_250_000,
          corrected_value: 1_205_000,
          evidence: { status: "passed" },
          state: "corrected",
          decided_by: actor.id
        }
      ]);
      const decided = events.find((event) => event.type === "data_store.record_decided");
      expect(decided).toMatchObject({
        metadata: { store: "findings", table: "objekt", field: "kaufpreis", action: "correct" }
      });
      expectNoField(decided, 1_250_000, 1_205_000, 1402);
      // A re-sync of the document leaves both values as they are.
      await call(w, "records.propose", {
        table: "objekt",
        items: [await w.item("a12", "kaufvertrag", { kaufpreis: 1_250_000 })]
      });
      expect(
        await w.target`select value, corrected_value, state from catalyst.record_fields`
      ).toEqual([{ value: 1_250_000, corrected_value: 1_205_000, state: "corrected" }]);
    });

    it("compares pinned peers by the corrected value, not the value read", async () => {
      // b12 says 1.205.000, as a12 was corrected to: they agree, though a12 reads 1.250.000.
      const agreeing = await corrected("keep-agree", 1_205_000);
      await agreeing.pin();
      expect(await agreeing.w.target`select kaufpreis::float8 from objekt`).toEqual([
        { kaufpreis: 1_205_000 }
      ]);
      expect((await flagged(agreeing.w)).items).toEqual([]);
      // b12 says 1.250.000, as a12 reads: it disagrees with the correction.
      const disagreeing = await corrected("keep-disagree", 1_250_000);
      await disagreeing.pin();
      expect(await disagreeing.w.target`select kaufpreis from objekt`).toEqual([
        { kaufpreis: null }
      ]);
    });

    it("shows both values in Prüfen with who corrected and when, to a reader who may use the Knowledge Base and to no other", async () => {
      const { w, actor, pin } = await corrected("keep-shown", 1_300_000);
      await pin();
      const { items } = await flagged(w);
      expect(items.map(({ documentId, reason }) => ({ documentId, reason }))).toEqual([
        { documentId: "a12", reason: "conflict" },
        { documentId: "b12", reason: "conflict" },
        { documentId: "c12", reason: "conflict" }
      ]);
      expect(items[0]).toMatchObject({
        value: 1_250_000,
        correctedValue: 1_205_000,
        quote: "1250000",
        evidence: { status: "passed" },
        state: "corrected",
        decidedBy: actor.id,
        decidedAt: expect.any(String)
      });
      expect(items[1]).toMatchObject({ value: 1_300_000, correctedValue: null });
      const { output } = await callAs(w, reviewerOf(w), "records.flagged", { limit: 100 });
      expect(output).toEqual({ items: [] });
      expectNoField(output, 1_250_000, 1_205_000);
    });

    it("leaves both values with the candidate's row: a withdrawn document shows neither, and its purge leaves no copy", async () => {
      const { w, pin } = await corrected("keep-withdrawn", 1_300_000);
      await pin();
      await w.source`update catalyst_kb.documents set withdrawn_at = now() where id = 'a12'`;
      const after = await flagged(w);
      expect(after.items.map((item) => item.documentId)).toEqual(["b12", "c12"]);
      expectNoField(after, 1_250_000, 1_205_000);
      // The purge deletes the candidate's row: no other row of the store's own schema holds
      // either value.
      await w.target`delete from catalyst.record_fields where document_id = 'a12'`;
      expect(
        await w.target`select count(*)::int as n from catalyst.record_fields
          where value::text in ('1250000', '1205000') or corrected_value::text in ('1250000', '1205000')`
      ).toEqual([{ n: 0 }]);
      for (const row of await w.target`select * from catalyst.loads`)
        expectNoField(row, 1_250_000, 1_205_000);
    });
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
    expectNoField(notice, 1402);
    const handler = w.dataStores.reviewNotice;
    const preview = (access?: ActorAccess) =>
      handler.preview(handler.validate(required(notice).payload), {
        clientInstanceId: w.clientInstanceId,
        requestId: required(notice).id,
        correlationId: "records-review",
        ...(access ? { viewer: { access, inList: true } } : {})
      });
    // Read without a reader, the notice holds no count: there is nobody to count for.
    expect(await preview()).not.toHaveProperty("flagged");
    const admin = () => preview(accessOf(recordsActorOf(w.clientInstanceId)));
    // Two fields in conflict and one unassigned field.
    expect(await admin()).toMatchObject({ store: "findings", title: "Findings", flagged: 3 });
    await call(w, "records.decide", {
      table: "objekt",
      key: 1402,
      field: "baujahr",
      action: "confirm",
      knowledgeBaseId: w.kbId,
      documentId: "a6"
    });
    expect(await admin()).toMatchObject({ flagged: 2 });
  });

  it("counts for each reader only the fields whose candidates come from a Knowledge Base they may use, as their list shows", async () => {
    const w = await world("readers");
    const gutachten = await w.knowledgeBase("gutachten", "Gutachten");
    await call(w, "records.propose", {
      table: "objekt",
      items: [
        // kaufpreis disagrees within unterlagen alone, baujahr within gutachten alone, and
        // wohnflaeche between the two; a gutachten document waits for its object.
        await w.item("a11", "kaufvertrag", { kaufpreis: 100, wohnflaeche: 80 }),
        await w.item("b11", "kaufvertrag", { kaufpreis: 200 }),
        await gutachten.item("g11", "kaufvertrag", { baujahr: 1990, wohnflaeche: 90 }),
        await gutachten.item("h11", "kaufvertrag", { baujahr: 1991 }),
        await gutachten.item(
          "e11",
          "expose",
          { adresse: "Nebenweg 2" },
          "2026-10-18",
          "/Other/e.pdf"
        )
      ]
    });
    const [notice] = await notices(w);
    const handler = w.dataStores.reviewNotice;
    const using = (id: string, ...knowledgeBaseIds: string[]) => {
      const actor = reviewerOf(w, id);
      return {
        actor,
        access: accessOf(actor, {
          grants: knowledgeBaseIds.map((scopeId, index) => ({
            id: `grant_${id}_${String(index)}`,
            clientInstanceId: actor.clientInstanceId,
            holderKind: "user",
            holderId: id,
            action: "knowledge_base.use",
            effect: "allow",
            scopeKind: "asset",
            scopeId,
            grantedBy: asUserId("records-admin"),
            createdAt: "2026-10-24T00:00:00.000Z"
          }))
        })
      };
    };
    /** The reader's count on the notice, and the fields their "Prüfen" list groups. */
    const seen = async ({ actor, access }: ReturnType<typeof using>) => {
      const preview = await handler.preview(handler.validate(required(notice).payload), {
        clientInstanceId: w.clientInstanceId,
        requestId: required(notice).id,
        correlationId: "records-review",
        viewer: { access, inList: true }
      });
      const { output } = await callAs(
        w,
        actor,
        "records.flagged",
        { limit: 100 },
        { kind: "user" },
        access
      );
      const items = dataStoreRecordsFlaggedOutputSchema.parse(output).items;
      return {
        flagged: preview.flagged,
        listed: groupFlagged(items).fieldCount,
        documents: [...new Set(items.map((item) => item.documentId))].sort()
      };
    };
    const unterlagen = using("reader-unterlagen", w.kbId);
    const gutachtenReader = using("reader-gutachten", gutachten.kbId);
    expect(await seen(unterlagen)).toEqual({
      flagged: 2,
      listed: 2,
      documents: ["a11", "b11"]
    });
    expect(await seen(gutachtenReader)).toEqual({
      flagged: 3,
      listed: 3,
      documents: ["e11", "g11", "h11"]
    });
    expect(await seen(using("reader-both", w.kbId, gutachten.kbId))).toMatchObject({
      flagged: 4,
      listed: 4
    });
    expect(await seen(using("reader-none"))).toEqual({ flagged: 0, listed: 0, documents: [] });
    // A deny on one Knowledge Base wins over the right to use every one.
    const denied = reviewerOf(w, "reader-denied");
    const deniedAccess = accessOf(denied, {
      grants: [
        {
          id: "grant_reader-denied_use",
          clientInstanceId: denied.clientInstanceId,
          holderKind: "user",
          holderId: denied.id,
          action: "knowledge_base.use",
          effect: "allow",
          scopeKind: "instance",
          grantedBy: asUserId("records-admin"),
          createdAt: "2026-10-24T00:00:00.000Z"
        },
        {
          id: "grant_reader-denied_deny",
          clientInstanceId: denied.clientInstanceId,
          holderKind: "user",
          holderId: denied.id,
          action: "knowledge_base.use",
          effect: "deny",
          scopeKind: "asset",
          scopeId: gutachten.kbId,
          grantedBy: asUserId("records-admin"),
          createdAt: "2026-10-24T00:00:00.000Z"
        }
      ]
    });
    expect(await seen({ actor: denied, access: deniedAccess })).toEqual({
      flagged: 2,
      listed: 2,
      documents: ["a11", "b11"]
    });
    // A withdrawn document leaves the count with its candidates, for the reader who saw it.
    await gutachten.source`update catalyst_kb.documents set withdrawn_at = now() where id = 'e11'`;
    expect(await seen(gutachtenReader)).toEqual({
      flagged: 2,
      listed: 2,
      documents: ["g11", "h11"]
    });
    expect(await seen(unterlagen)).toMatchObject({ flagged: 2, listed: 2 });
  });

  it("counts past the first 500 cited documents of a Knowledge Base, leaving out a withdrawn one on a later page", async () => {
    const w = await world("paging-count");
    const ids = Array.from({ length: 502 }, (_, index) => `p${String(index).padStart(3, "0")}`);
    await call(w, "records.propose", {
      table: "objekt",
      items: await Promise.all(
        ids.map((id) =>
          w.item(id, "expose", { adresse: `Weg ${id}` }, "2026-10-18", `/Other/${id}.pdf`)
        )
      )
    });
    // One on the first page of 500 and the last, alone on the second.
    await w.source`update catalyst_kb.documents set withdrawn_at = now() where id in ('p250', 'p501')`;
    const [notice] = await notices(w);
    const handler = w.dataStores.reviewNotice;
    const preview = await handler.preview(handler.validate(required(notice).payload), {
      clientInstanceId: w.clientInstanceId,
      requestId: required(notice).id,
      correlationId: "records-review",
      viewer: { access: accessOf(recordsActorOf(w.clientInstanceId)), inList: true }
    });
    const listed = groupFlagged((await flagged(w, { limit: 1_000 })).items).fieldCount;
    expect({ flagged: preview.flagged, listed }).toEqual({ flagged: 500, listed: 500 });
  });
});
