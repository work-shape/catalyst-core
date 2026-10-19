// Bundled with esbuild for Node. This imports the committed seed rather than its shared-target CLI.
import { seedDemo } from "../src/seed/index.ts";
import { hostEnvironment } from "../src/env.ts";
import { writeFile, rm } from "node:fs/promises";
const [baseUrl, appConfigPath, root, privateDir, reportPath] = process.argv.slice(2);
if (process.argv.slice(2).length !== 5) throw new Error("Expected five owned-stack seed arguments");
const requests = [];
try {
  const report = await seedDemo({
    baseUrl,
    appConfigPath,
    assetsDir: `${root}/clients/demo/seed`,
    instanceAssetsDir: `${root}/clients/demo`,
    env: hostEnvironment(),
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      const path = new URL(typeof url === "string" || url instanceof URL ? url : url.url).pathname;
      requests.push({ path, status: response.status });
      if (requests.length > 8) requests.shift();
      return response;
    },
    envFile: `${privateDir}/cli.env`
  });
  await writeFile(
    reportPath,
    JSON.stringify({ steps: report.steps.map(({ created, existing }) => ({ created, existing })) }),
    { mode: 0o600 }
  );
} catch (error) {
  await writeFile(
    reportPath,
    JSON.stringify({
      code: error instanceof Error ? error.name : "seed_failure",
      steps: requests,
      source:
        error instanceof Error
          ? error.stack
              ?.split("\n")
              .filter((line) => line.trim().startsWith("at "))
              .slice(0, 6)
              .join("\n")
          : undefined
    }),
    { mode: 0o600 }
  );
  throw new Error("Committed seed failed; see minimized seed report");
} finally {
  await rm(`${privateDir}/cli.env`, { force: true });
}
