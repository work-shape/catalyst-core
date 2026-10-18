// Bundled with esbuild for Node. This imports the committed seed rather than its shared-target CLI.
import { seedDemo } from "../src/seed/index.ts";
import { hostEnvironment } from "../src/env.ts";
import { writeFile, rm } from "node:fs/promises";
const [baseUrl, appConfigPath, root, privateDir, reportPath] = process.argv.slice(2);
try {
  const report = await seedDemo({
    baseUrl,
    appConfigPath,
    assetsDir: `${root}/clients/demo/seed`,
    instanceAssetsDir: `${root}/clients/demo`,
    env: hostEnvironment(),
    envFile: `${privateDir}/cli.env`
  });
  await writeFile(
    reportPath,
    JSON.stringify({ steps: report.steps.map(({ created, existing }) => ({ created, existing })) }),
    { mode: 0o600 }
  );
} finally {
  await rm(`${privateDir}/cli.env`, { force: true });
}
