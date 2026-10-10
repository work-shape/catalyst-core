import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileSetPathIssue } from "@vivd-catalyst/core";
import { z } from "zod";
import {
  DEFAULT_PAGE_BUILD_LIMITS,
  PAGE_BUILD_FILES_DIRECTORY,
  PAGE_BUILD_MAX_ERRORS,
  PAGE_BUILD_MAX_MESSAGE_CHARS,
  PAGE_BUILD_MAX_OUTPUT_DEPTH,
  PAGE_BUILD_MAX_RESULT_BYTES,
  PAGE_BUILD_RESULT_FILE,
  type PageBuildLimits
} from "./limits";
import { builtPageManifestSchema } from "./manifest";
import type { PageBuildOutcome, PageFile } from "./types";

// What a build left in its output directory is read here, by the worker. The build ran where
// the author's files could have run code, so nothing in the directory is trusted: a name may be
// a link to a file of the worker, a file may be larger than any Page, the result may be any
// text. Only regular files with one name are read, each through one open that follows no link,
// and never more bytes than the limit that is left.

const reportedError = z.strictObject({
  file: z.string().min(1).max(512),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  message: z.string().max(PAGE_BUILD_MAX_MESSAGE_CHARS + 3),
  code: z
    .enum([
      "manifest_invalid",
      "file_invalid",
      "inline_event_handler",
      "external_resource",
      "import_unavailable",
      "syntax",
      "routes_invalid",
      "output_too_large"
    ])
    .optional(),
  element: z.string().max(64).optional(),
  attribute: z.string().max(64).optional()
});

const resultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("built"), manifest: builtPageManifestSchema }),
  z.strictObject({
    status: z.literal("errors"),
    errors: z.array(reportedError).min(1).max(PAGE_BUILD_MAX_ERRORS)
  })
]);

/** What a build writes into `result.json`. */
export type PageBuildResultFile = z.infer<typeof resultSchema>;

class OutputRefused extends Error {}

/** Reads the output directory of one build. It never rejects for what the directory holds. */
export async function readPageBuildOutput(
  outputDirectory: string,
  limits: Partial<PageBuildLimits> = {}
): Promise<PageBuildOutcome> {
  const { maxOutputBytes, maxOutputFiles } = { ...DEFAULT_PAGE_BUILD_LIMITS, ...limits };
  try {
    const text = await readRegularFile(
      join(outputDirectory, PAGE_BUILD_RESULT_FILE),
      PAGE_BUILD_MAX_RESULT_BYTES,
      PAGE_BUILD_RESULT_FILE
    );
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(text));
    } catch {
      throw new OutputRefused("The result of the build is not JSON.");
    }
    const result = resultSchema.safeParse(value);
    if (!result.success) {
      throw new OutputRefused("The result of the build does not have the expected form.");
    }
    if (result.data.status === "errors") {
      return { status: "errors", errors: result.data.errors };
    }
    const files: PageFile[] = [];
    const budget = { bytes: maxOutputBytes, files: maxOutputFiles };
    await readBuiltFiles(join(outputDirectory, PAGE_BUILD_FILES_DIRECTORY), "", 0, budget, files);
    const { manifest } = result.data;
    if (!files.some((file) => file.path === manifest.entry)) {
      throw new OutputRefused("The build wrote no entry file.");
    }
    return { status: "built", manifest, kitVersion: manifest.kit, files };
  } catch (error) {
    if (error instanceof OutputRefused) {
      return { status: "failed", reason: "output_refused", message: error.message };
    }
    throw error;
  }
}

async function readBuiltFiles(
  directory: string,
  prefix: string,
  depth: number,
  budget: { bytes: number; files: number },
  files: PageFile[]
): Promise<void> {
  if (depth > PAGE_BUILD_MAX_OUTPUT_DEPTH) {
    throw new OutputRefused("The built files are nested too deep.");
  }
  // `lstat` and the directory entries describe the name itself: a link is seen as a link.
  const self = await lstat(directory).catch(() => undefined);
  if (!self?.isDirectory()) {
    throw new OutputRefused("The build wrote no directory of built files.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${prefix}${entry.name}`;
    const issue = fileSetPathIssue(path);
    if (issue) {
      throw new OutputRefused(`A built file has a path that cannot be stored: ${issue}.`);
    }
    if (entry.isDirectory()) {
      await readBuiltFiles(join(directory, entry.name), `${path}/`, depth + 1, budget, files);
      continue;
    }
    if (!entry.isFile()) {
      throw new OutputRefused(`'${path}' in the build's output is not a regular file.`);
    }
    if (budget.files <= 0) {
      throw new OutputRefused("The build wrote more files than a Page may have.");
    }
    budget.files -= 1;
    const bytes = await readRegularFile(join(directory, entry.name), budget.bytes, path);
    budget.bytes -= bytes.byteLength;
    files.push({ path, bytes });
  }
}

/**
 * The bytes of one regular file, at most `maxBytes` of them. The open follows no link in the
 * last name, and what is read is what was opened: kind, link count and size are asked of the
 * open file, not of its name again.
 */
async function readRegularFile(file: string, maxBytes: number, name: string): Promise<Uint8Array> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new OutputRefused(`'${name}' in the build's output is missing or is not a regular file.`);
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new OutputRefused(`'${name}' in the build's output is not a regular file of its own.`);
    }
    if (stat.size > maxBytes) {
      throw new OutputRefused(`'${name}' takes the build's output over its size limit.`);
    }
    // One byte more than allowed is asked for, so a file that grew after `stat` is noticed
    // without reading it to its end.
    const buffer = new Uint8Array(Math.min(stat.size, maxBytes) + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, length, buffer.byteLength - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes || length > stat.size) {
      throw new OutputRefused(`'${name}' takes the build's output over its size limit.`);
    }
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
