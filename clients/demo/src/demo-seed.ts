import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readManifest, resolveInstance } from "@work-shape/catalyst-cli";
import { hostEnvironment } from "./env";
import { assertLocalDevelopmentHost } from "./seed/adapters/local-network";
import { seedDemo } from "./seed/run";

// `pnpm demo:seed`: fills the running local demo with its test company. See the README.

const clientRoot = fileURLToPath(new URL("..", import.meta.url));
const env = hostEnvironment();

try {
  // The instance of the demo's own manifest, or the URL the variable names.
  // Checked before anything reads it, so an address that is refused is never printed.
  if (env.DEMO_SEED_URL) assertLocalDevelopmentHost(env.DEMO_SEED_URL);
  const instance = resolveInstance(await readManifest(clientRoot), env.DEMO_SEED_URL);
  const { origin } = assertLocalDevelopmentHost(instance.url);
  const report = await seedDemo({
    baseUrl: instance.url,
    appConfigPath: resolve(clientRoot, "config/app.yaml"),
    assetsDir: resolve(clientRoot, "seed"),
    instanceAssetsDir: clientRoot,
    env,
    envFile: resolve(clientRoot, ".env")
  });
  console.log(`Seeded ${origin}:`);
  for (const step of report.steps) {
    console.log(`  ${step.name}: ${step.created} created, ${step.existing} already there`);
    if (step.note) console.log(`    ${step.note}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
