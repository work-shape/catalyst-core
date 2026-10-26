import { renderRuntimeRules } from "@work-shape/catalyst-app-build";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Builds the references of the shipped skill `platform-docs` from the platform's documentation
// pages. `node scripts/platform-docs.ts` writes them; with `--check` it fails where what is
// written differs from the pages, which a test runs, so a changed page fails the checks until
// they are written again. The reference files are made from the pages and never kept by hand.

const here = dirname(fileURLToPath(import.meta.url));

/** Where the documentation pages are. */
const DOCS_ROOT = resolve(here, "../../docs/src/content/docs");

/** Where the references are written, beside the skill that ships them. */
const GENERATED_FILE = resolve(here, "../src/generated/platform-docs.json");

/**
 * Pages that are no reference: the API reference, which the docs build writes from the OpenAPI
 * document and Git ignores. The landing page is `.mdx` and only links to the others.
 */
const SKIPPED_DIRECTORIES = ["reference/api"];

interface PlatformDocsPage {
  /** The page's path below the docs, without extension, such as `configure/cli`. */
  path: string;
  title: string;
  description: string;
  /**
   * The page's text without its front matter, one entry per line, so that two changes to
   * different paragraphs of one page change different lines of the generated file.
   */
  body: string[];
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      const page = relative(DOCS_ROOT, path).split(sep).join("/");
      if (entry.isDirectory()) {
        return SKIPPED_DIRECTORIES.includes(page) ? [] : markdownFiles(path);
      }
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    })
  );
  return files.flat();
}

/** The value of one `key: value` line of front matter, without quotes. */
function frontMatterValue(frontMatter: string, key: string, file: string): string {
  const line = frontMatter.split("\n").find((candidate) => candidate.startsWith(`${key}:`));
  const value = line
    ?.slice(key.length + 1)
    .trim()
    .replace(/^(["'])(.*)\1$/u, "$2");
  if (!value) throw new Error(`The docs page ${file} has no '${key}' in its front matter`);
  return value;
}

function pageOf(file: string, text: string): PlatformDocsPage {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  if (!match?.[1]) throw new Error(`The docs page ${file} has no front matter`);
  return {
    path: relative(DOCS_ROOT, file).split(sep).join("/").replace(/\.md$/u, ""),
    title: frontMatterValue(match[1], "title", file),
    description: frontMatterValue(match[1], "description", file),
    body: text.slice(match[0].length).trim().split("\n")
  };
}

/** Every page of the documentation, by path. */
async function readPlatformDocsPages(): Promise<PlatformDocsPage[]> {
  const files = await markdownFiles(DOCS_ROOT);
  const pages = await Promise.all(
    files.map(async (file) => pageOf(file, await readFile(file, "utf8")))
  );
  return pages.sort((left, right) => left.path.localeCompare(right.path));
}

/** The text of the generated file for these pages. */
function renderPlatformDocs(pages: readonly PlatformDocsPage[]): string {
  return `${JSON.stringify({ pages }, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sandboxFile = join(DOCS_ROOT, "apps/sandbox.md");
  const sandbox = await readFile(sandboxFile, "utf8");
  const start = "<!-- runtime-rules:start -->";
  const end = "<!-- runtime-rules:end -->";
  const startOffset = sandbox.indexOf(start);
  const endOffset = sandbox.indexOf(end);
  if (startOffset < 0 || endOffset < startOffset) {
    throw new Error("apps/sandbox.md is missing its runtime-rules section markers.");
  }
  const section = `${start}\n${renderRuntimeRules()}\n${end}`;
  const updated = sandbox.slice(0, startOffset) + section + sandbox.slice(endOffset + end.length);
  if (sandbox !== updated) {
    if (process.argv.includes("--check")) {
      throw new Error("apps/sandbox.md runtime rules differ. Run pnpm generate:platform-docs.");
    }
    await writeFile(sandboxFile, updated);
  }
  const pages = await readPlatformDocsPages();
  const text = renderPlatformDocs(pages);
  const file = relative(process.cwd(), GENERATED_FILE);
  if (process.argv.includes("--check")) {
    // What the test runs: the written references must be what the pages make.
    const written = await readFile(GENERATED_FILE, "utf8").catch(() => "");
    if (written !== text) {
      process.stderr.write(
        `${file} differs from the docs pages. Run pnpm generate:platform-docs and commit it.\n`
      );
      process.exit(1);
    }
  } else {
    await writeFile(GENERATED_FILE, text);
    process.stdout.write(`Wrote ${pages.length} docs pages to ${file}\n`);
  }
}
