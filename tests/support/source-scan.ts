import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SOURCE_FILE = /\.(?:ts|tsx|mts|js|mjs)$/u;
const GENERATED_FILE = /\.gen\.ts$/u;
const URL_LITERAL = /https?:\/\/([A-Za-z0-9.-]+)/gu;
/** A read of the environment by a name that is computed, such as `env[name]`. */
const COMPUTED_ENV_READ = /\benv\[(?!["'])[^\]]+\](?!\s*=[^=])/gu;
const SECRET_NAMED_ENV_READ =
  /\benv\??\.([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL)[A-Z0-9_]*)\b/gu;

/**
 * Hosts that address nothing outside the machine or the test: loopback, the reserved test
 * names, and the `http://schemas.` names of XML namespaces, which are identifiers.
 */
function isAddressOfNothing(url: string, host: string): boolean {
  return (
    ["127.0.0.1", "localhost", "0.0.0.0", "example.com"].includes(host) ||
    /\.(?:test|example|localhost|invalid)$/u.test(host) ||
    url.startsWith("http://schemas.")
  );
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(path);
      }
      return SOURCE_FILE.test(entry.name) && !GENERATED_FILE.test(entry.name) ? [path] : [];
    })
  );
  return nested.flat();
}

export interface SourceScan {
  /** `<file> <host>` for every address of a real host outside a `src/adapters/` folder. */
  hostLiterals: string[];
  /** `<file>` for every read of the environment by a computed name. */
  computedEnvReads: string[];
  /** `<file> <NAME>` for every read of a variable whose name says it holds a secret. */
  secretNamedEnvReads: string[];
}

/**
 * Reads the product source of a repository: `src` and `tools` of every package and client.
 * A provider's address belongs in its adapter and a secret is read by the resolver, so both
 * are searched for everywhere else.
 */
export async function scanProductSource(repositoryRoot: string): Promise<SourceScan> {
  const scan: SourceScan = { hostLiterals: [], computedEnvReads: [], secretNamedEnvReads: [] };
  const owners = (
    await Promise.all(
      ["packages", "clients"].map(async (group) =>
        (await readdir(join(repositoryRoot, group), { withFileTypes: true }).catch(() => []))
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(repositoryRoot, group, entry.name))
      )
    )
  ).flat();
  const files = (
    await Promise.all(
      owners.flatMap((owner) => [
        sourceFiles(join(owner, "src")),
        sourceFiles(join(owner, "tools"))
      ])
    )
  ).flat();
  for (const file of files.sort()) {
    const path = relative(repositoryRoot, file).replaceAll("\\", "/");
    const text = await readFile(file, "utf8");
    if (!path.includes("/src/adapters/")) {
      for (const match of text.matchAll(URL_LITERAL)) {
        const host = match[1] ?? "";
        if (!isAddressOfNothing(match[0], host)) {
          scan.hostLiterals.push(`${path} ${host}`);
        }
      }
    }
    for (const _match of text.matchAll(COMPUTED_ENV_READ)) {
      scan.computedEnvReads.push(path);
    }
    for (const match of text.matchAll(SECRET_NAMED_ENV_READ)) {
      scan.secretNamedEnvReads.push(`${path} ${match[1] ?? ""}`);
    }
  }
  return scan;
}
