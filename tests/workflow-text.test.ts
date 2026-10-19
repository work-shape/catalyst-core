import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_MARKDOWN_MAX_COLUMNS,
  WORKFLOW_MARKDOWN_MAX_ROWS,
  WORKFLOW_TEXT_FORMAT_MARKDOWN,
  mailSendInputSchema,
  type JsonObject,
  type JsonValue,
  type OperationDefinition
} from "@work-shape/catalyst-core";
import {
  WORKFLOW_TEXT_INPUT_INVALID,
  WORKFLOW_TEXT_PART_INVALID,
  WorkflowStepFailure,
  checkDatasetContracts,
  escapeMarkdownText,
  joinText,
  parseWorkflowManifest,
  referencedMarkdown
} from "@work-shape/catalyst-workflows";

// EW-TEXT: text joined from parts in a step's input mapping, events-workflows-and-guardrails.md
// check 143. The save and publish check runs `checkDatasetContracts`; the run joins the parts
// with `joinText`, which `workflow-text-runs.test.ts` drives through a run.

const ref = (step: string, path: string) => ({ ref: { step, path } });
const markdownField = { type: "string", format: WORKFLOW_TEXT_FORMAT_MARKDOWN } as const;
const row = (fields: number): JsonObject => ({
  type: "object",
  properties: Object.fromEntries(
    Array.from({ length: fields }, (_, index) => [`f${index}`, { type: "string" }])
  ),
  additionalProperties: false
});
const records = (count: number): JsonValue[] =>
  Array.from({ length: count }, (_, index) => ({ mandant: `M${index}`, count: index }));

/** One reference part, as the run hands it to the join. */
const value = (resolved: JsonValue, schema?: JsonObject) => ({
  value: resolved,
  part: 2,
  ...(schema ? { schema } : {})
});

function failureOf(join: () => string): WorkflowStepFailure {
  try {
    join();
  } catch (error) {
    if (error instanceof WorkflowStepFailure) return error;
    throw error;
  }
  throw new Error("The join did not fail");
}

describe("the text value form in a definition", () => {
  const manifest = (input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    id: "mandanten-check",
    name: "Mandanten-Check",
    runAs: "runner",
    inputs: {
      type: "object",
      properties: { monat: { type: "string" } },
      additionalProperties: false
    },
    outputs: { type: "object" },
    ...extra,
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "result", name: "Result", type: "output", input }
    ]
  });

  it("takes a text beside a literal and a reference in a step's mapping", () => {
    const parsed = parseWorkflowManifest(
      manifest({
        subject: { text: ["Prüfergebnis ", ref("start", "input.monat")] },
        literal: { value: "x" },
        referenced: ref("start", "input.monat")
      })
    );
    expect(parsed.ok).toBe(true);
  });

  it("refuses a text in a run label and in a child's run key, which take no text", () => {
    const labelled = parseWorkflowManifest(
      manifest({}, { labels: { monat: { text: [ref("start", "input.monat")] } } })
    );
    expect(labelled.ok).toBe(false);
    const keyed = parseWorkflowManifest({
      ...manifest({}),
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "child",
          name: "Child",
          type: "workflow",
          workflow: "pruefung",
          input: {},
          key: [{ text: ["M-", ref("start", "input.monat")] }]
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    expect(keyed.ok).toBe(false);
  });

  it("names the part whose reference names no step", () => {
    const parsed = parseWorkflowManifest(
      manifest({ subject: { text: ["Prüfergebnis ", ref("monat", "label")] } })
    );
    expect(parsed).toMatchObject({
      ok: false,
      issues: [
        {
          path: "steps.result.input.subject.text.1",
          message:
            "Part 2 of 'subject' of the step 'result' refers to 'monat', and no step has that id"
        }
      ]
    });
  });

  it("refuses a part that references a later step, as any reference out of scope", () => {
    const parsed = parseWorkflowManifest({
      ...manifest({}),
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "early",
          name: "Early",
          type: "code",
          file: "early.py",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          input: { note: { text: ["Spät: ", ref("late", "x")] } }
        },
        {
          id: "late",
          name: "Late",
          type: "code",
          file: "late.py",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
          input: {}
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    expect(parsed).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "reference_out_of_scope", path: "steps.early" })]
    });
  });
});

describe("the reference check of each part at save and publish", () => {
  const definitions = { read: async () => undefined };
  // As MAIL-1 registers it: the Zod schema alone, no `inputJsonSchema`. The check and the run
  // read the body's `format: markdown` and the subject's limit from the schema it derives.
  const mailSend: OperationDefinition = {
    name: "mail.send",
    effect: "changing",
    auth: "principal",
    action: "mail_sender.use",
    scope: null,
    timeoutMs: 1000,
    inputSchema: mailSendInputSchema,
    outputSchema: z.object({}),
    resource: () => undefined,
    execute: async () => {
      throw new Error("Metadata only");
    }
  };
  const registry = { resolve: async () => mailSend };

  /** A Workflow whose code step `findings` answers `output`, read by a mail step. */
  async function check(
    input: Record<string, unknown>,
    output: JsonObject = {
      type: "object",
      properties: {
        label: { type: "string" },
        count: { type: "integer" },
        sent: { type: ["boolean", "null"] },
        mandant: { type: "object", properties: { name: { type: "string" } } },
        names: { type: "array", items: { type: "string" } },
        rows: { type: "array", items: row(3) },
        wide: { type: "array", items: row(WORKFLOW_MARKDOWN_MAX_COLUMNS + 1) },
        nested: {
          type: "array",
          items: { type: "object", properties: { inner: { type: "object" } } }
        },
        lists: { type: "array", items: { type: "array", items: { type: "string" } } },
        table: { type: "dataset", row: row(2) }
      },
      additionalProperties: false
    }
  ) {
    const parsed = parseWorkflowManifest({
      id: "mandanten-check",
      name: "Mandanten-Check",
      runAs: "runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "findings",
          name: "Findings",
          type: "code",
          file: "findings.py",
          inputSchema: { type: "object" },
          outputSchema: output,
          input: {}
        },
        {
          id: "mail",
          name: "Send the mail",
          type: "operation",
          operation: "mail.send",
          input: { to: { value: [{ address: "a@workshape.ai" }] }, ...input }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    return checkDatasetContracts(parsed.manifest, definitions, registry);
  }

  const refusal = (field: string, part?: number) => ({
    code: "VALIDATION_FAILED",
    details: {
      reason: WORKFLOW_TEXT_PART_INVALID,
      step: "mail",
      field,
      ...(part === undefined ? {} : { part })
    }
  });

  it("accepts texts, numbers and yes-or-no values in a subject, lists and tables in the body", async () => {
    await expect(
      check({
        subject: {
          text: [
            "Prüfergebnis ",
            ref("findings", "label"),
            ": ",
            ref("findings", "count"),
            ref("findings", "sent"),
            ref("findings", "mandant.name")
          ]
        },
        body: {
          text: ["## Befunde\n\n", ref("findings", "rows"), "\n", ref("findings", "names")]
        }
      })
    ).resolves.toBeUndefined();
  });

  it("refuses a part that references an object, naming the step, the field and the part", async () => {
    const refused = check({
      subject: { text: ["Prüfergebnis für ", ref("findings", "mandant")] }
    });
    await expect(refused).rejects.toMatchObject(refusal("subject", 2));
    await expect(refused).rejects.toThrow(
      "Step 'mail', field 'subject', part 2 references an object, which is no text"
    );
  });

  it("refuses a part that names a field the earlier step does not declare", async () => {
    const refused = check({ subject: { text: ["Monat ", ref("findings", "monat")] } });
    await expect(refused).rejects.toMatchObject(refusal("subject", 2));
    await expect(refused).rejects.toThrow("'findings.monat' names no field of that step's output");
  });

  it("refuses a list outside a Markdown field", async () => {
    await expect(
      check({ subject: { text: ["Namen: ", ref("findings", "names")] } })
    ).rejects.toMatchObject(refusal("subject", 2));
  });

  it("reads the Markdown body of an operation that carries only its Zod schema", async () => {
    // Without the derived schema the body would be no Markdown field: a list would be refused
    // here, and at run time a value would join unescaped and could add a link to the mail.
    expect(mailSend.inputJsonSchema).toBeUndefined();
    await expect(
      check({ body: { text: ["Namen:\n\n", ref("findings", "names")] } })
    ).resolves.toBeUndefined();
    // A described operation's own JSON Schema still comes first.
    const described = {
      ...mailSend,
      inputJsonSchema: { type: "object", properties: { body: { type: "string" } } }
    };
    const parsed = parseWorkflowManifest({
      id: "described",
      name: "Described",
      runAs: "runner",
      inputs: {
        type: "object",
        properties: { names: { type: "array", items: { type: "string" } } }
      },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "mail",
          name: "Send the mail",
          type: "operation",
          operation: "mail.send",
          input: { body: { text: [ref("start", "input.names")] } }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    await expect(
      checkDatasetContracts(parsed.manifest, definitions, { resolve: async () => described })
    ).rejects.toMatchObject(refusal("body", 1));
  });

  it("refuses a dataset in a Markdown field", async () => {
    const refused = check({ body: { text: ["Befunde\n\n", ref("findings", "table")] } });
    await expect(refused).rejects.toMatchObject(refusal("body", 2));
    await expect(refused).rejects.toThrow(
      "references a dataset, which a Markdown field does not take"
    );
  });

  it("refuses records of more than 8 fields, records that are not flat, and lists of lists", async () => {
    await expect(check({ body: { text: [ref("findings", "wide")] } })).rejects.toThrow(
      `a table has at most ${WORKFLOW_MARKDOWN_MAX_COLUMNS} columns`
    );
    await expect(check({ body: { text: [ref("findings", "nested")] } })).rejects.toThrow(
      "not all flat"
    );
    await expect(check({ body: { text: [ref("findings", "lists")] } })).rejects.toThrow(
      "a list of lists"
    );
  });

  it("takes a text in a field one of whose alternatives is a string", async () => {
    // `to` takes one address or a list of recipients.
    await expect(
      check({ to: { text: [ref("findings", "label"), "@workshape.ai"] }, locale: { text: ["de"] } })
    ).resolves.toBeUndefined();
  });

  it("refuses a text in a field that is no string", async () => {
    const parsed = parseWorkflowManifest({
      id: "counts",
      name: "Counts",
      runAs: "runner",
      inputs: { type: "object" },
      outputs: { type: "object", properties: { count: { type: "integer" } } },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        { id: "result", name: "Result", type: "output", input: { count: { text: ["3"] } } }
      ]
    });
    if (!parsed.ok) throw new Error("Invalid test definition");
    const refused = checkDatasetContracts(parsed.manifest, definitions, registry);
    await expect(refused).rejects.toMatchObject({
      details: { reason: WORKFLOW_TEXT_PART_INVALID, step: "result", field: "count" }
    });
    await expect(refused).rejects.toThrow(
      "Step 'result': the field 'count' is no text, so it takes no text joined from parts"
    );
  });

  it("lets a part through whose schema is not known, for the run to check", async () => {
    await expect(
      check({ subject: { text: ["x ", ref("findings", "anything")] } }, { type: "object" })
    ).resolves.toBeUndefined();
  });
});

describe("joining the parts when the step runs", () => {
  it("joins literals and references in order, a number and a yes-or-no value as text", () => {
    expect(
      joinText({ name: "subject" }, [
        { literal: "Prüfergebnis " },
        value("September 2026"),
        { literal: " für " },
        value("Bäckerei Krause"),
        { literal: ": " },
        value(3),
        { literal: " " },
        value(true)
      ])
    ).toBe("Prüfergebnis September 2026 für Bäckerei Krause: 3 true");
  });

  it("joins null as empty text", () => {
    expect(joinText({ name: "subject" }, [{ literal: "a" }, value(null), { literal: "b" }])).toBe(
      "ab"
    );
  });

  it("keeps a value as it is outside a Markdown field", () => {
    expect(joinText({ name: "subject" }, [value("[Krause](https://x.example) *fett*")])).toBe(
      "[Krause](https://x.example) *fett*"
    );
  });

  it("refuses an object, a list outside Markdown and a dataset, naming the part and no value", () => {
    const object = failureOf(() => joinText({ name: "subject" }, [value({ secret: "x" })]));
    expect(object.code).toBe(WORKFLOW_TEXT_INPUT_INVALID);
    expect(object.message).toBe("Part 2 of 'subject' is an object, which is no text");
    expect(failureOf(() => joinText({ name: "subject" }, [value(["a"])])).message).toContain(
      "only a Markdown field joins"
    );
    const dataset = failureOf(() =>
      joinText({ name: "body", schema: markdownField }, [
        value({ $dataset: "ds_1", rowCount: 3, bytes: 90 })
      ])
    );
    expect(dataset.message).toContain("is a dataset, which a Markdown field does not take");
  });

  it("fails a text longer than the field allows with input_invalid", () => {
    const failure = failureOf(() =>
      joinText({ name: "subject", schema: { type: "string", maxLength: 10 } }, [
        { literal: "Prüfergebnis " },
        value("September")
      ])
    );
    expect(failure.code).toBe("input_invalid");
    expect(failure.message).toBe(
      "The text joined for 'subject' is longer than the 10 characters the field allows"
    );
    // The limit counts characters, not bytes.
    expect(
      joinText({ name: "subject", schema: { type: "string", maxLength: 3 } }, [value("äöü")])
    ).toBe("äöü");
  });
});

describe("a Markdown field", () => {
  const body = { name: "body", schema: markdownField };

  it("escapes every referenced value, so it adds no link, image, formatting or HTML", () => {
    const joined = joinText(body, [
      { literal: "**Mandant:** " },
      value("[Krause](https://evil.example) ![x](https://t.example/p.png) *fett* <b>x</b> `c`")
    ]);
    expect(joined).toBe(
      "**Mandant:** \\[Krause\\]\\(https\\:\\/\\/evil\\.example\\) \\!\\[x\\]\\(https\\:\\/\\/t\\.example\\/p\\.png\\) \\*fett\\* \\<b\\>x\\<\\/b\\> \\`c\\`"
    );
  });

  it("escapes what would start a block: a heading, a list, a quote, a rule, an indented code", () => {
    expect(escapeMarkdownText("# Titel")).toBe("\\# Titel");
    expect(escapeMarkdownText("- a")).toBe("\\- a");
    expect(escapeMarkdownText("1. a")).toBe("1\\. a");
    expect(escapeMarkdownText("> a")).toBe("\\> a");
    expect(escapeMarkdownText("a\n===")).toBe("a\\\n\\=\\=\\=");
    expect(escapeMarkdownText("    code")).toBe("&#32;&#32;&#32;&#32;code");
    // A line break is a hard break, never a blank line that would start a block.
    expect(escapeMarkdownText("a\n\nb")).toBe("a\\\n\\\nb");
    expect(escapeMarkdownText("a & b &amp;")).toBe("a \\& b \\&amp\\;");
  });

  it("leaves the author's literal Markdown as written", () => {
    expect(joinText(body, [{ literal: "## Befunde\n\n*fett*" }])).toBe("## Befunde\n\n*fett*");
  });

  it("joins a list of strings as a bulleted list, apart from the text around it", () => {
    expect(
      joinText(body, [
        { literal: "Offen:" },
        value(["Krause [GmbH]", "Müller\nund Söhne", 7]),
        { literal: "Ende" }
      ])
    ).toBe("Offen:\n\n- Krause \\[GmbH\\]\n- Müller und Söhne\n- 7\n\nEnde");
  });

  it("joins a list of 100 flat records as a table in the order of the row schema", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: { mandant: { type: "string", title: "Mandant" }, count: { type: "integer" } }
      }
    };
    const joined = joinText(body, [value(records(WORKFLOW_MARKDOWN_MAX_ROWS), schema)]);
    const lines = joined.split("\n");
    expect(lines.slice(0, 3)).toEqual(["| Mandant | count |", "| --- | --- |", "| M0 | 0 |"]);
    expect(lines).toHaveLength(WORKFLOW_MARKDOWN_MAX_ROWS + 2);
  });

  it("escapes each cell and keeps a record's line on one row", () => {
    expect(joinText(body, [value([{ name: "a|b\nc", note: null, done: false }])])).toBe(
      "| done | name | note |\n| --- | --- | --- |\n| false | a\\|b c |  |"
    );
  });

  it("refuses a list of 101 rows", () => {
    const failure = failureOf(() =>
      joinText(body, [value(records(WORKFLOW_MARKDOWN_MAX_ROWS + 1))])
    );
    expect(failure.code).toBe(WORKFLOW_TEXT_INPUT_INVALID);
    expect(failure.message).toBe("Part 2 of 'body' is a list of more than 100 rows");
  });

  it("refuses more than 8 columns, a record that is not flat, and a list that mixes", () => {
    const wide = Object.fromEntries(
      Array.from({ length: WORKFLOW_MARKDOWN_MAX_COLUMNS + 1 }, (_, index) => [`f${index}`, index])
    );
    expect(failureOf(() => joinText(body, [value([wide])])).message).toContain(
      "a table has at most 8 columns"
    );
    expect(failureOf(() => joinText(body, [value([{ a: { b: 1 } }])])).message).toContain(
      "not all flat"
    );
    expect(failureOf(() => joinText(body, [value([{ a: 1 }, "b"])])).message).toContain(
      "mixes records"
    );
  });

  it("joins an empty list as nothing", () => {
    expect(joinText(body, [{ literal: "a" }, value([]), { literal: "b" }])).toBe("ab");
  });
});

describe("a Markdown field mapped as one reference (MAIL-2)", () => {
  it("keeps emphasis, lists, tables and a value without a link as they are", () => {
    const markdown = "**Stand:** gut.\n\n- eins\n- zwei\n\n| a | b |\n| --- | --- |\n| 1 | [2] |";
    expect(referencedMarkdown(markdown)).toBe(markdown);
  });

  it("shows each link's address after its label, and a reference's alike without its definition", () => {
    expect(referencedMarkdown('Bitte [Ihre Bank](https://evil.example/login "Bank") öffnen.')).toBe(
      "Bitte Ihre Bank (<https://evil.example/login>) öffnen."
    );
    expect(referencedMarkdown("[https://kanzlei.de](https://evil.example)")).toBe(
      "https://kanzlei.de (<https://evil.example/>)"
    );
    expect(referencedMarkdown("Siehe [Akte][a].\n\n[a]: https://evil.example/akte")).toBe(
      "Siehe Akte (<https://evil.example/akte>).\n\n"
    );
    // A label defined twice links to its first definition, as CommonMark reads it.
    expect(
      referencedMarkdown(
        "[Akte][a]\n\n[a]: https://kanzlei.example/akte\n[a]: https://evil.example"
      )
    ).toBe("Akte (<https://kanzlei.example/akte>)\n\n\n");
    expect(referencedMarkdown("| x |\n| --- |\n| [a](https://e.example/a\\|b) |")).toBe(
      "| x |\n| --- |\n| a (<https://e.example/a%7Cb>) |"
    );
  });

  it("keeps a link that shows its own address, and shows a look-alike host in ASCII", () => {
    expect(referencedMarkdown("<https://kanzlei.de/> and <anna@kanzlei.de>")).toBe(
      "<https://kanzlei.de/> and <anna@kanzlei.de>"
    );
    expect(referencedMarkdown("<https://b\u0430nk.de>")).toBe(
      "https://b\u0430nk.de (<https://xn--bnk-6cd.de/>)"
    );
  });

  it("shows the address of a link that brackets around another one make", () => {
    expect(referencedMarkdown("[[x](https://real.example)](https://evil.example)")).toBe(
      "x (<https://real.example/>) (<https://evil.example/>)"
    );
  });

  it("leaves images out, a relative address as text, and raw HTML as written", () => {
    expect(
      referencedMarkdown("![](https://track.example/p.gif)Hallo [![a](i.png)](https://u.example)")
    ).toBe("Hallo <https://u.example/>");
    expect(referencedMarkdown("[Akte](/akten/1)")).toBe("Akte (\\/akten\\/1)");
    expect(referencedMarkdown('<a href="https://evil.example">Bank</a>')).toBe(
      '<a href="https://evil.example">Bank</a>'
    );
  });
});
