#!/usr/bin/env node
import { preflightReport } from "./agent-stories/preflight-report.mjs";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plan } from "./agent-stories/catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const selection = plan(process.argv.slice(2));
  console.log(
    JSON.stringify(
      {
        stories: selection.stories,
        model: selection.model ?? "recorded in the reused stack",
        cases: selection.cases.map((c) => ({
          id: c.id,
          prerequisite: c.prerequisite,
          deadlineMs: c.deadlineMs
        })),
        coverage: selection.coverage
      },
      null,
      2
    )
  );
  if (!selection.cases.length) {
    await preflightReport(root, selection, "no_implemented_cases");
    process.exitCode = 2;
  } else {
    const helper = resolve(root, "../scripts/lane/browser");
    await access(helper).catch(async () => {
      await preflightReport(root, selection, "missing_workspace_lane_helper");
      throw new Error(
        "Missing composite workspace scripts/lane/browser; refusing uncoordinated startup"
      );
    });
    const child = spawn(
      helper,
      [
        "agent-stories",
        "--",
        process.execPath,
        resolve(root, "scripts/agent-stories/run.mjs"),
        ...process.argv.slice(2)
      ],
      { cwd: root, stdio: "inherit" }
    );
    for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
    child.on("error", () => {
      console.error("Browser lane helper failed to start");
      process.exitCode = 2;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 2;
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
