import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { DockerWorkspaceCommandProcessExecutor } from "@work-shape/catalyst-tool-execution";
import { createCodeSandbox, parseWorkflowManifest } from "@work-shape/catalyst-workflows";

const image = process.env.CATALYST_RUNNER_IMAGE;
describe.skipIf(!image)("Workflow packages in the runner image", () => {
  it("imports declared pandas and pypdf in a code step and verifies the manifest without network", async () => {
    const manifest = parseWorkflowManifest({
      id: "pdf",
      name: "PDF",
      runAs: "runner",
      packages: ["pypdf", "pandas"],
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "parse",
          name: "Parse",
          type: "code",
          file: "steps/parse.py",
          input: {},
          inputSchema: { type: "object" },
          outputSchema: { type: "object" }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    expect(manifest.ok).toBe(true);
    const tempRoot = await mkdtemp(join(tmpdir(), "ew-pkg-image-"));
    const sandbox = new DockerWorkspaceCommandProcessExecutor({
      image: image ?? "",
      containerNamePrefix: `ew-pkg-${randomUUID().slice(0, 8)}`
    });
    try {
      const run = createCodeSandbox({
        sandbox,
        tempRoot,
        outputMaxBytes: 4096,
        limits: {
          memoryBytes: 256 * 1024 * 1024,
          cpuCount: 1,
          pidsLimit: 64,
          scratchBytes: 16 * 1024 * 1024
        }
      }).run;
      const result = await run({
        id: randomUUID(),
        signal: new AbortController().signal,
        staged: {
          language: "python",
          file: "parse.py",
          input: {},
          timeoutSeconds: 30,
          source: await readFile(
            new URL("../packages/deployment-kit/verify/runner-packages.py", import.meta.url),
            "utf8"
          )
        }
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        kind: "ended",
        outcome: {
          kind: "output",
          value: { pypdf: "imported", pandas: "imported", network: "none" }
        }
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
