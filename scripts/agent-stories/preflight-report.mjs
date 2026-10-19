import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function preflightReport(root, selection, code) {
  const startedAt = new Date().toISOString();
  const folder = resolve(
    root,
    "../tmp/agent-stories",
    `${startedAt.replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`
  );
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const results = selection.cases.map((c) => ({ scenario: c.id, status: "blocked", code }));
  const summary = {
    startedAt,
    results,
    coverage: selection.coverage,
    usage: { calls: 0, tokens: 0, micros: 0 },
    cleanup: "No services or credentials created",
    exitCode: 2
  };
  await writeFile(resolve(folder, "summary.json"), JSON.stringify(summary, null, 2), {
    mode: 0o600
  });
  await writeFile(
    resolve(folder, "manifest.json"),
    JSON.stringify(
      {
        startedAt,
        stories: selection.stories,
        prerequisites: selection.cases.map((c) => c.prerequisite)
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  await writeFile(
    resolve(folder, "report.md"),
    `# Agent stories: prerequisite/coverage stop\n\n${code}. Exit 2. No paid calls or stack mutation.\n\n${selection.coverage.map((c) => `- ${c.id}: ${c.status}; manual: ${c.manual.join("; ")}`).join("\n")}\n\nRuns: ${startedAt.slice(0, 10)} | automated trial blocked before startup | ${selection.stories.join(",")} | ${code} | EUR 0; 0 tokens | ${folder}/report.md\n`,
    { mode: 0o600 }
  );
  console.log(`Agent stories report: ${folder}/report.md (exit 2)`);
}
