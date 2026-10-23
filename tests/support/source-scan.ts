import ts from "typescript";
import { deniedNames } from "./name-hashes";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const SOURCE_FILE = /\.(?:ts|tsx|mts|js|mjs)$/u;
const PRODUCT_TEXT_FILE = /\.(?:ts|tsx|mts|js|mjs|md|mdx|yaml|yml|json|py|sh)$/u;
/** A quoted name that starts with `demo.`, unless it is a file name such as a config file. */
const DEMO_TOOL_NAME = /["'`]demo\.(?!(?:ya?ml|json|md|ts|tsx|js|mjs|sh)\b)[A-Za-z0-9_]+/gu;
/** The deployment kit keeps its source outside `src`, partly in files without an extension. */
const DEPLOYMENT_KIT = "packages/deployment-kit";
const DEPLOYMENT_KIT_FOLDERS = ["lib", "host", "verify", "bin", "dev"];
const ANY_FILE = /(?:)/u;
const DEMO_PERMISSION = /["'`]demo-tools["'`]/gu;
const PERSONAL_PATH = /\/Users\/|[A-Z]:\\{1,2}Users\\{1,2}/gu;
const GENERATED_FILE = /\.gen\.ts$/u;
// Keep explicit URLs in comments covered too. Browser authority forms are checked in
// parsed string values below, so regex escapes such as /\\s/ are never mistaken for hosts.
const URL_LITERAL = /https?:\/\/([A-Za-z0-9.-]+)|\b(cdn\.tailwindcss\.com|unpkg\.com)\b/giu;
const BROWSER_URL_LITERAL = /(?:https?:[\\/]+|(?<![:\\/])[\\/]{2,})([A-Za-z0-9.-]+)/giu;

function outsideHosts(text: string, file: string): string[] {
  const hosts = new Set<string>();
  const check = (value: string, pattern: RegExp) => {
    for (const match of value.matchAll(pattern)) {
      const host = (match[1] ?? match[2] ?? "").toLowerCase();
      if (!isAddressOfNothing(match[0], host)) hosts.add(host);
    }
  };
  check(text, URL_LITERAL);
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddleOrTemplateTail(node)
    )
      check(node.text, BROWSER_URL_LITERAL);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest));
  return [...hosts];
}
/** A read of the environment by a name that is computed, such as `env[name]`. */
const COMPUTED_ENV_READ = /\benv\[(?!["'])[^\]]+\](?!\s*=[^=])/gu;
const SECRET_NAMED_ENV_READ =
  /\benv\??\.([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|DATABASE_URL)[A-Z0-9_]*)\b/gu;

/**
 * Hosts that address nothing outside the machine or the test: loopback, the reserved test
 * names, and the `http://schemas.` names of XML namespaces, which are identifiers. So is the
 * start of the first line of a Git LFS pointer file, `version https://git-lfs`: it is compared
 * with the bytes of a file and ends before any domain, so the host is `git-lfs` and no more.
 * The same line written out to its domain is the address of a real host and is still found.
 */
function isAddressOfNothing(url: string, host: string): boolean {
  return (
    ["127.0.0.1", "localhost", "0.0.0.0", "example.com"].includes(host) ||
    /\.(?:test|example|localhost|invalid)$/u.test(host) ||
    url.toLowerCase().startsWith("http://schemas.") ||
    url === "https://git-lfs"
  );
}

async function sourceFiles(directory: string, extension = SOURCE_FILE): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return entry.name === "node_modules" || entry.name === "dist"
          ? []
          : sourceFiles(path, extension);
      }
      return extension.test(entry.name) && !GENERATED_FILE.test(entry.name) ? [path] : [];
    })
  );
  return nested.flat();
}

export interface SourceScan {
  /** `<file> <host>` for every address of a real host outside a `src/adapters/` folder. */
  hostLiterals: string[];
  customerNames: string[];
  demoToolNames: string[];
  personalPaths: string[];
  /** `<file>` for every read of the environment by a computed name. */
  computedEnvReads: string[];
  /** `<file> <NAME>` for every read of a variable whose name says it holds a secret. */
  secretNamedEnvReads: string[];
}

/**
 * Reads the product source of a repository: `src` and `tools` of every package and client.
 * Name and personal-path guards also read package scripts and documentation, client widgets,
 * the deployment kit and the name guard itself. Customer vocabulary is compared through one-way hashes.
 * A provider's address belongs in its adapter and a secret is read by the resolver, so both
 * are searched for everywhere else.
 */
export async function scanProductSource(repositoryRoot: string): Promise<SourceScan> {
  const scan: SourceScan = {
    hostLiterals: [],
    computedEnvReads: [],
    secretNamedEnvReads: [],
    customerNames: [],
    demoToolNames: [],
    personalPaths: []
  };
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
      for (const host of outsideHosts(text, file)) scan.hostLiterals.push(`${path} ${host}`);
    }
    for (const _match of text.matchAll(COMPUTED_ENV_READ)) {
      scan.computedEnvReads.push(path);
    }
    for (const match of text.matchAll(SECRET_NAMED_ENV_READ)) {
      scan.secretNamedEnvReads.push(`${path} ${match[1] ?? ""}`);
    }
  }
  const nameFiles = new Set([
    ...files,
    ...(
      await Promise.all(
        owners.flatMap((owner) => [
          sourceFiles(join(owner, "src"), PRODUCT_TEXT_FILE),
          sourceFiles(join(owner, "scripts"), PRODUCT_TEXT_FILE),
          sourceFiles(join(owner, "widgets"), PRODUCT_TEXT_FILE),
          sourceFiles(join(owner, "docs"), PRODUCT_TEXT_FILE)
        ])
      )
    ).flat(),
    ...(
      await Promise.all(
        DEPLOYMENT_KIT_FOLDERS.map((folder) =>
          sourceFiles(join(repositoryRoot, DEPLOYMENT_KIT, folder), ANY_FILE)
        )
      )
    ).flat(),
    ...(await sourceFiles(
      join(repositoryRoot, "tests"),
      /^(?:source-names\.test|source-scan)\.ts$/u
    ))
  ]);
  for (const file of [...nameFiles].sort()) {
    const path = relative(repositoryRoot, file).replaceAll("\\", "/");
    const text = await readFile(file, "utf8");
    for (const name of deniedNames(text)) scan.customerNames.push(`${path} ${name}`);
    if (!path.startsWith("clients/demo/")) {
      for (const match of text.matchAll(DEMO_TOOL_NAME)) {
        scan.demoToolNames.push(`${path} ${match[0]}`);
      }
      for (const match of text.matchAll(DEMO_PERMISSION)) {
        scan.demoToolNames.push(`${path} ${match[0]}`);
      }
    }
    if (
      /^packages\/[^/]+\/(?:src|scripts)\//u.test(path) ||
      DEPLOYMENT_KIT_FOLDERS.some((folder) => path.startsWith(`${DEPLOYMENT_KIT}/${folder}/`))
    ) {
      for (const match of text.matchAll(PERSONAL_PATH)) {
        scan.personalPaths.push(`${path} ${match[0]}`);
      }
    }
  }
  return scan;
}

/** The immutable checkout is scanned once; mutable fixture roots use scanProductSource. */
export const productSourceScan = scanProductSource(resolve(import.meta.dirname, "../.."));
