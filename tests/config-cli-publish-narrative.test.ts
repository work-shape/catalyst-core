import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { runCli } from "@work-shape/catalyst-cli";
import platformContext from "./fixtures/cli-platform-context.json";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function publish(kind: "app" | "workflow", answers: string[], summary: string, json = false) {
  const cwd = await mkdtemp(join(tmpdir(), "cli-publish-narrative-"));
  directories.push(cwd);
  const output: string[] = [];
  const stdout: string[] = [];
  const questions: { question: string; output: string }[] = [];
  const requests: Request[] = [];
  const warning =
    "The step ‘Mail an Mandanten’ will stop: the guardrail ‘Mail approval’ asks for approval.";
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path === apiOperations["access_tokens.exchange"].path) {
      return Response.json({ accessToken: "fixture-access", expiresAt: "2099-01-01T00:00:00Z" });
    }
    if (path === apiOperations["platform.context.get"].path) {
      return Response.json({
        ...platformContext,
        kinds: [
          {
            kind,
            plural: `${kind}s`,
            lifecycle: "draft_published",
            representation: "files",
            owners: ["instance", "workspace"],
            actions: {
              read: `${kind}.read`,
              delete: `${kind}.delete`,
              write: `${kind}.write`,
              publish: `${kind}.publish`,
              approve: `${kind}.approve`
            }
          }
        ]
      });
    }
    if (path === apiOperations["assets.get"].buildPath({ params: { kind, name: "nightly" } })) {
      return Response.json({
        id: "asset-nightly",
        kind,
        name: "nightly",
        scope: { kind: "workspace", workspaceId: "w1" },
        revision: 7,
        contentRevision: 7,
        config: {
          manifest: { name: "Nachtimport", actions: [] },
          ...(kind === "workflow"
            ? { files: [{ path: "steps/import.ts", content: "private-row-value-do-not-print" }] }
            : {})
        },
        ...(kind === "app" && new URL(request.url).searchParams.get("files") === "true"
          ? {
              files: [
                {
                  path: "steps/import.ts",
                  text: "private-row-value-do-not-print",
                  contentType: "text/plain",
                  sha256: "fixture-hash",
                  bytes: 30
                }
              ]
            }
          : {}),
        publishNarrative: { summary, warnings: [warning] },
        publishQuestion: ["The limit is higher than the default."],
        updatedAt: "2026-10-18T00:00:00Z"
      });
    }
    if (
      request.method === "POST" &&
      path === apiOperations["assets.publish"].buildPath({ params: { kind, name: "nightly" } })
    ) {
      return Response.json({ draftRevision: 7, publishedRevision: 7 });
    }
    throw new Error(`Unexpected request: ${request.method} ${path}`);
  };
  const code = await runCli(
    [
      kind,
      "publish",
      "nightly",
      "--revision",
      "7",
      "--workspace",
      "w1",
      "--instance",
      "https://catalyst.test",
      ...(json ? ["--json"] : [])
    ],
    {
      cwd,
      env: { CATALYST_API_KEY: "fixture-key" },
      fetchImpl,
      stdout: (text) => {
        stdout.push(text);
        output.push(text);
      },
      stderr: (text) => output.push(text),
      prompt: async (question) => {
        questions.push({ question, output: output.join("") });
        const answer = answers.shift();
        if (answer === undefined) throw new Error("Unexpected extra publish question");
        return answer;
      }
    }
  );
  return { code, output: output.join(""), stdout: stdout.join(""), questions, requests, warning };
}

describe("PUBQ-1 CLI publish question (check 75)", () => {
  it.each([
    { kind: "app", json: false },
    { kind: "workflow", json: false },
    { kind: "app", json: true },
    { kind: "workflow", json: true }
  ] as const)(
    "leads $kind with the shared sentence and opens Details on request (json=$json)",
    async ({ kind, json }) => {
      const summary =
        "Nachtimport runs every night at 02:00 as its own account, reads Exampledata, writes Findings and sends mail. The 14 people of Kai Spezis see those rows in Findings.";
      const result = await publish(kind, ["d", "n"], summary, json);
      expect(result.code).toBe(1);
      if (json) expect(result.stdout).toBe("");
      expect(result.questions, result.output).toHaveLength(2);
      expect(result.questions[0]?.output).toBe(`${summary}\n${result.warning}\n`);
      expect(result.questions[0]?.question).toContain("d=Details");
      expect(result.questions[1]?.output).toContain(
        kind === "workflow" ? "steps/import.ts" : "Publish revision 7"
      );
      expect(result.output).not.toContain("private-row-value-do-not-print");
      expect(
        result.requests.some(
          (request) => request.method === "POST" && request.url.includes("/publish")
        )
      ).toBe(false);
    }
  );

  it("publishes the reviewed Workflow revision only after Details and an explicit yes", async () => {
    const result = await publish("workflow", ["details", "yes"], "Nachtimport reads Exampledata.");
    expect(result.code, result.output).toBe(0);
    const request = result.requests.find(
      (request) => request.method === "POST" && request.url.includes("/publish")
    );
    expect(request).toBeDefined();
    expect(await request?.json()).toEqual({ revision: 7, workspaceId: "w1" });
    expect(request?.headers.get("catalyst-unattended")).toBeNull();
  });

  it("preserves the reader's German sentence rather than reconstructing it in English", async () => {
    const summary =
      "Nachtimport läuft jede Nacht um 02:00 mit dem eigenen Konto und liest Exampledata.";
    const result = await publish("workflow", ["n"], summary);
    expect(result.questions[0]?.output, result.output).toContain(summary);
    expect(result.questions[0]?.output).not.toContain("Details\n");
  });
});
