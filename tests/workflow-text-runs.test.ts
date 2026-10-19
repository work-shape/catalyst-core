import { afterEach, describe, expect, it } from "vitest";
import {
  WORKFLOW_MARKDOWN_MAX_ROWS,
  WORKFLOW_TEXT_FORMAT_MARKDOWN,
  type JsonValue
} from "@work-shape/catalyst-core";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { NOTE, readyWorkflows, start, stepRunsOf } from "./support/workflow-runs";

// EW-TEXT at run time (events-workflows-and-guardrails.md check 143): a published Workflow
// reads clients from the Connection `crm` and joins a subject and a Markdown body from them in
// its result, whose schema declares the subject's limit and the body's `format: markdown`.

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

const ref = (step: string, path: string) => ({ ref: { step, path } });

function report(subjectMaxLength = 200) {
  return {
    id: "notify-clients",
    name: "Client report",
    runAs: "workflow-runner",
    inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    outputs: {
      type: "object",
      properties: {
        subject: { type: "string", maxLength: subjectMaxLength },
        body: { type: "string", format: WORKFLOW_TEXT_FORMAT_MARKDOWN }
      }
    },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "clients",
        name: "Read the clients",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: ref("start", "input.note") }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: {
          // `scheduledFor` is null for a run started by hand, and joins as empty text.
          subject: {
            text: ["Bericht: ", ref("start", "input.note"), ref("start", "scheduledFor")]
          },
          body: { text: ["## Mandanten\n\n", ref("clients", "clients"), "Ende"] }
        }
      }
    ]
  };
}

async function runWith(clients: JsonValue[], subjectMaxLength?: number) {
  const definitions = publishedDefinitions();
  definitions.publish(report(subjectMaxLength));
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: definitions.source }
  );
  // A list of 101 clients is more than the fixture's Connection answers by default.
  t.state.limits = { ...t.state.limits, resultMaxBytes: 64 * 1024 };
  t.setBehaviour(() => Promise.resolve({ clients }));
  return { t, run: await t.finish((await start(t)).id) };
}

describe("a text joined from parts when the step runs", () => {
  it("joins the subject, and the referenced records as an escaped table in the body", async () => {
    const { run } = await runWith([
      { id: "client-anna", name: "Anna [GmbH](https://evil.example)" },
      { id: "client-bert", name: "**Bert**" }
    ]);
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({
      subject: `Bericht: ${NOTE}`,
      body: [
        "## Mandanten",
        "",
        "| id | name |",
        "| --- | --- |",
        "| client\\-anna | Anna \\[GmbH\\]\\(https\\:\\/\\/evil\\.example\\) |",
        "| client\\-bert | \\*\\*Bert\\*\\* |",
        "",
        "Ende"
      ].join("\n")
    });
  });

  it("joins a list of 100 records as a table", async () => {
    const clients = Array.from({ length: WORKFLOW_MARKDOWN_MAX_ROWS }, (_, index) => ({
      id: `c${index}`
    }));
    const { run } = await runWith(clients);
    expect(run.status).toBe("done");
  });

  it("fails the step with input_invalid on a list of 101 records", async () => {
    const clients = Array.from({ length: WORKFLOW_MARKDOWN_MAX_ROWS + 1 }, (_, index) => ({
      id: `c${index}`
    }));
    const { t, run } = await runWith(clients);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({
      code: "input_invalid",
      message: "Part 2 of 'body' is a list of more than 100 rows"
    });
    const result = (await stepRunsOf(t, run.id)).find((stepRun) => stepRun.stepId === "result");
    expect(result).toMatchObject({ status: "failed", error: { code: "input_invalid" } });
  });

  it("fails the step with input_invalid when the joined text is longer than its field allows", async () => {
    const { run } = await runWith([{ id: "client-anna" }], 10);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({
      code: "input_invalid",
      message: "The text joined for 'subject' is longer than the 10 characters the field allows"
    });
    // The message names the field and its limit, and nothing of the text.
    expect(run.error?.message).not.toContain(NOTE);
  });
});
