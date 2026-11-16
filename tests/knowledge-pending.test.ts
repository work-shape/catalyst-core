import { describe, expect, it, vi } from "vitest";
import {
  asUserId,
  knowledgePendingOutputSchema,
  knowledgePendingRowSchema,
  LEGACY_LIST_GRANTOR,
  type KnowledgeExtractor,
  type WorkflowDatasetReference
} from "@work-shape/catalyst-core";
import { knowledgePendingPageRows } from "@work-shape/catalyst-data-stores";
import { clientInstanceId } from "./support/data-store-instance";
import { required } from "./support/assertions";
import { useKnowledgeWorkflow } from "./support/knowledge-workflow";

// PROC-W, the reading half: a Workflow step pulls the documents of a Knowledge Base whose pages
// changed after a time, each with its pages as a dataset of the step run. The documents here were
// processed by the built-in processors, so their pages are the stored extraction.

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Two visible sheets, as the document-processing capability reads a price list. */
const SHEETS = [
  {
    page: 1,
    text: "| Art.-Nr. | Bezeichnung | Preis |\n| --- | --- | --- |\n| A-1 | Mischer | 100 |"
  },
  { page: 2, text: "| Stufe | Rabatt |\n| --- | --- |\n| A | 5% |" }
];

const extractor: KnowledgeExtractor = {
  revision: 1,
  extract: async () => ({ pages: SHEETS }),
  process: async () => ({
    documents: [{ pageFrom: 1, pageTo: 2 }],
    pages: SHEETS,
    sections: [
      { title: "Armaturen", pageFrom: 1, pageTo: 1 },
      { title: "Rabatte", pageFrom: 2, pageTo: 2 }
    ],
    fields: {}
  })
};

describe(
  "a Workflow pulls changed documents of a Knowledge Base (PROC-W)",
  { timeout: 600_000 },
  () => {
    const { world } = useKnowledgeWorkflow();

    it("hands out built-in documents with their pages, and only what changed after since", async () => {
      const process = vi.spyOn(extractor, "process");
      const w = await world(undefined, undefined, extractor);
      await w.instance.stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: w.principal.id,
        action: "knowledge_base.read",
        effect: "allow",
        scopeKind: "asset",
        scopeId: w.kb.id,
        grantedBy: asUserId(LEGACY_LIST_GRANTOR)
      });
      const priceList = w.world.put({
        folderId: "folder",
        name: "preisliste.xlsx",
        mime: XLSX,
        bytes: new TextEncoder().encode("price list v1")
      });
      w.world.put({
        folderId: "folder",
        name: "notes.txt",
        mime: "text/plain",
        bytes: new TextEncoder().encode("Lieferung ab Lager")
      });
      await w.drain(await w.sync());
      expect(process).toHaveBeenCalledTimes(1);

      const pull = async (input: Record<string, unknown>) => {
        const run = await w.startRun();
        const outcome = await run.call("pending", input);
        expect(outcome.result.status, JSON.stringify(outcome.result)).toBe("done");
        await run.endStep(run.lastStep());
        const { documents } = knowledgePendingOutputSchema.parse(
          "output" in outcome.result ? outcome.result.output : undefined
        );
        const rows = (await read(run.runId, documents)).map((row) =>
          knowledgePendingRowSchema.parse(row)
        );
        return { runId: run.runId, rows };
      };
      async function read(runId: string, reference: WorkflowDatasetReference) {
        const rows: unknown[] = [];
        for await (const row of (
          await w.datasets.reader({ id: reference.$dataset, runId, reference })
        ).rows)
          rows.push(row);
        return rows;
      }

      const first = await pull({ limit: 10 });
      expect(first.rows.map((row) => row.name)).toEqual(
        expect.arrayContaining(["preisliste.xlsx", "notes.txt"])
      );
      expect(first.rows).toHaveLength(2);
      const sheet = required(first.rows.find((row) => row.name === "preisliste.xlsx"));
      expect(sheet).toMatchObject({
        type: "default",
        source: "source",
        path: "/preisliste.xlsx",
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
      });
      // One row per sheet, its tables as Markdown, straight from the stored extraction.
      expect(await read(first.runId, sheet.pages)).toEqual(SHEETS);
      const notes = required(first.rows.find((row) => row.name === "notes.txt"));
      expect(await read(first.runId, notes.pages)).toEqual([
        { page: 1, text: "Lieferung ab Lager" }
      ]);
      // Oldest change first.
      expect([...first.rows].sort((a, b) => a.changedAt.localeCompare(b.changedAt))).toEqual(
        first.rows
      );

      // Nothing changed after the last change, so nothing is pending since it.
      const since = required(first.rows.at(-1)).changedAt;
      expect((await pull({ since, limit: 10 })).rows).toEqual([]);
      // Another type than the documents' is empty; the fallback type names them all.
      expect((await pull({ type: "rechnung", limit: 10 })).rows).toEqual([]);
      expect((await pull({ type: "default", limit: 10 })).rows).toHaveLength(2);

      // A new version of the price list is pending since then, with its new content.
      w.world.write(priceList, new TextEncoder().encode("price list v2"));
      await w.drain(await w.sync("changes"));
      const changed = await pull({ since, limit: 10 });
      expect(changed.rows).toEqual([
        expect.objectContaining({ id: sheet.id, name: "preisliste.xlsx" })
      ]);
      const [updated] = changed.rows;
      expect(updated?.contentHash).not.toBe(sheet.contentHash);
      expect(Date.parse(required(updated).changedAt)).toBeGreaterThan(Date.parse(since));
      // The same instant written with another offset.
      const offset = new Date(Date.parse(since) + 2 * 3_600_000)
        .toISOString()
        .replace("Z", "+02:00");
      expect(Date.parse(offset)).toBe(Date.parse(since));
      expect((await pull({ since: offset, limit: 10 })).rows).toHaveLength(1);

      // A limit of one hands out the oldest; its moment as since hands out the next.
      const one = await pull({ limit: 1 });
      expect(one.rows).toHaveLength(1);
      const rest = await pull({ since: required(one.rows[0]).changedAt, limit: 10 });
      expect([...one.rows, ...rest.rows].map((row) => row.id).sort()).toEqual(
        first.rows.map((row) => row.id).sort()
      );
    });

    it("runs only as a step of a Workflow Run and needs the right to read the Knowledge Base", async () => {
      const w = await world();
      const run = await w.startRun();
      // The account may put documents in but has no knowledge_base.read.
      const refused = await run.call("pending", { limit: 10 });
      expect(refused.result.status).not.toBe("done");
      expect(JSON.stringify(refused.result)).toContain("knowledge_base.read");
    });
  }
);

describe("the page rows of a pending document", () => {
  it("keeps a page in one row while it fits, and goes on in rows of the same page after", () => {
    const short = [{ page: 1, text: "| a |\n| --- |\n| 1 |" }];
    expect([...knowledgePendingPageRows(short, 1_000)]).toEqual(short);
    const lines = Array.from({ length: 40 }, (_, index) => `| A-${index} | ${"x".repeat(20)} |`);
    const long = [{ page: 3, text: lines.join("\n") }];
    const rows = [...knowledgePendingPageRows(long, 200)];
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.page).toBe(3);
      expect(Buffer.byteLength(JSON.stringify(row)) + 1).toBeLessThanOrEqual(200);
    }
    expect(rows.map((row) => row.text).join("\n")).toBe(long[0]?.text);
    // A line longer than a row is cut where it fills one.
    const wide = [...knowledgePendingPageRows([{ page: 1, text: "ä".repeat(500) }], 200)];
    expect(wide.length).toBeGreaterThan(1);
    expect(wide.map((row) => row.text).join("")).toBe("ä".repeat(500));
  });
});
