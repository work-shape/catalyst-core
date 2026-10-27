import { SourceMap } from "node:module";
import { z } from "zod";
import { boundPreviewReport, type FileSet, type PreviewReport } from "@work-shape/catalyst-core";
import { readFileSetFile } from "../pages/page-file-sets";
import type { ResolvedChatServerOptions } from "../types";

// A build runs in the sandbox: its map is data, never a URL to fetch or code to execute.
const sourceMapSchema = z.object({
  version: z.literal(3),
  file: z.string().default(""),
  sources: z.array(z.string()),
  names: z.array(z.string()),
  mappings: z.string(),
  sourcesContent: z.array(z.string()).default([]),
  sourceRoot: z.literal("").default("")
});

/** Resolves bundle coordinates using only this revision's stored map and authored files. */
export async function previewSourceLocations(
  options: ResolvedChatServerOptions,
  fileSet: FileSet,
  report: PreviewReport
): Promise<PreviewReport> {
  const maps = new Map<string, SourceMap | undefined>();
  const entries = [];
  for (const entry of report.entries) {
    if (entry.file === undefined || !entry.line || !entry.column) {
      entries.push(entry);
      continue;
    }
    const path = `${entry.file}.map`;
    if (!maps.has(path)) {
      const file = fileSet.builtFiles.find((candidate) => candidate.path === path);
      let map: SourceMap | undefined;
      if (file) {
        // Storage errors still fail the request; an invalid map merely leaves bundle coordinates.
        const bytes = await readFileSetFile(options, fileSet, "dist", file);
        try {
          const payload = sourceMapSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
          map = new SourceMap(payload);
        } catch {
          // Older or malformed build output has no usable map.
        }
      }
      maps.set(path, map);
    }
    const origin = maps.get(path)?.findEntry(entry.line - 1, entry.column - 1);
    const source =
      origin && "originalSource" in origin
        ? origin.originalSource.replace(/^page:/u, "")
        : undefined;
    if (
      origin &&
      "originalLine" in origin &&
      source !== undefined &&
      fileSet.sourceFiles.some((file) => file.path === source)
    ) {
      entries.push({
        ...entry,
        file: source,
        line: origin.originalLine + 1,
        column: origin.originalColumn + 1
      });
    } else {
      entries.push(entry);
    }
  }
  // Source paths can be longer than bundle paths, or carry data. Scrub and enforce 2 KB again.
  return boundPreviewReport({ ...report, entries });
}
