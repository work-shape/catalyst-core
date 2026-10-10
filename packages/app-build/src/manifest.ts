import { load, JSON_SCHEMA, YAMLException } from "js-yaml";
import { fileSetPathIssue } from "@vivd-catalyst/core";
import { z } from "zod";
import { RELEASED_KIT_VERSIONS } from "./kit";
import type { PageBuildError } from "./errors";

/** The file of a Page that says what it is. */
export const PAGE_MANIFEST_FILE = "app.yaml";
/** A manifest is a few lines. One larger than this is refused before it is parsed. */
export const PAGE_MANIFEST_MAX_BYTES = 64 * 1024;
/** How many connections, actions or hosts one manifest lists. */
const MANIFEST_MAX_LIST_ENTRIES = 100;

const name = z.string().min(1).max(120);
const identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u, "lowercase letters, digits, '-' and '_', at most 63");
// A host name and nothing else: no scheme, no port, no path and no wildcard.
const hostName = z
  .string()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
    "an https host name such as 'api.example.com', without scheme, port, path or wildcard"
  );
const relativeFile = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "a path inside the Page's folder"
  });

const actionSchema = z.strictObject({
  name: identifier,
  file: relativeFile.optional(),
  effect: z.enum(["reading", "changing"]),
  policy: z.string().min(1).max(64).optional(),
  connection: identifier.optional(),
  cache: z
    .strictObject({
      ttl: z.number().int().min(0).max(86_400),
      scope: z.enum(["user", "workspace"]).optional()
    })
    .optional()
});

/** The manifest as an author writes it. A key that is not listed here is refused. */
export const pageManifestSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/u, "lowercase letters, digits and '-', at most 63"),
  name,
  description: z.string().max(2000).optional(),
  icon: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/u, "an icon name in lowercase letters, digits and '-'")
    .optional(),
  kit: z.string().refine((value) => RELEASED_KIT_VERSIONS.includes(value), {
    message: `an exact released kit version: ${RELEASED_KIT_VERSIONS.join(", ")}`
  }),
  entry: relativeFile
    .refine((value) => /\.html?$/iu.test(value), { message: "an HTML file of the Page" })
    .optional(),
  connections: z.array(identifier).max(MANIFEST_MAX_LIST_ENTRIES).optional(),
  actions: z.array(actionSchema).max(MANIFEST_MAX_LIST_ENTRIES).optional(),
  externalHosts: z.array(hostName).max(MANIFEST_MAX_LIST_ENTRIES).optional()
});

export type PageManifest = z.infer<typeof pageManifestSchema>;

/** The manifest as a build writes it: the author's, with the entry and the pages it derived. */
export const builtPageManifestSchema = pageManifestSchema.extend({
  entry: z.string().refine((value) => fileSetPathIssue(value) === undefined, {
    message: "a path of a built file"
  }),
  pages: z
    .array(z.strictObject({ path: z.string().min(1).max(512) }))
    .max(1000)
    .optional()
});

export type BuiltPageManifest = z.infer<typeof builtPageManifestSchema>;

export type ParsedPageManifest =
  { status: "valid"; manifest: PageManifest } | { status: "errors"; errors: PageBuildError[] };

/**
 * Reads and validates `app.yaml`. The text is parsed as data: the YAML schema used knows
 * strings, numbers, booleans, lists and maps and builds nothing else.
 */
export function parsePageManifest(bytes: Uint8Array): ParsedPageManifest {
  const fail = (message: string, line?: number): ParsedPageManifest => ({
    status: "errors",
    errors: [
      { file: PAGE_MANIFEST_FILE, message, code: "manifest_invalid", ...(line ? { line } : {}) }
    ]
  });
  if (bytes.byteLength > PAGE_MANIFEST_MAX_BYTES) {
    return fail(
      `The manifest has ${bytes.byteLength} bytes. It has at most ${PAGE_MANIFEST_MAX_BYTES} (PAGE_MANIFEST_MAX_BYTES).`
    );
  }
  let value: unknown;
  try {
    value = load(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
      schema: JSON_SCHEMA,
      filename: PAGE_MANIFEST_FILE
    });
  } catch (error) {
    if (error instanceof YAMLException) {
      return fail(`The manifest is not valid YAML: ${error.reason}`, error.mark.line + 1);
    }
    return fail("The manifest is not UTF-8 text.");
  }
  const parsed = pageManifestSchema.safeParse(value);
  if (parsed.success) {
    return { status: "valid", manifest: parsed.data };
  }
  return {
    status: "errors",
    errors: parsed.error.issues.map((issue) => ({
      file: PAGE_MANIFEST_FILE,
      code: "manifest_invalid" as const,
      message: describeIssue(issue)
    }))
  };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    const where = issue.path.length > 0 ? ` under '${issue.path.join(".")}'` : "";
    const derived = issue.keys.includes("pages")
      ? " 'pages' is derived from the files under src/routes/ and is not written by hand."
      : "";
    return `Unknown key${issue.keys.length > 1 ? "s" : ""} ${issue.keys.map((key) => `'${key}'`).join(", ")}${where}. A manifest holds id, name, description, icon, kit, entry, connections, actions and externalHosts.${derived}`;
  }
  const key = issue.path.length > 0 ? `'${issue.path.join(".")}'` : "The manifest";
  return `${key}: ${issue.message}`;
}
