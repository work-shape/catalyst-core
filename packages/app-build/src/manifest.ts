import { fileSetPathIssue, readYamlData } from "@vivd-catalyst/core";
import { z } from "zod";
import {
  compiledAppActionSchema,
  dataStoreReferenceSchema,
  externalHostSchema
} from "./action-input";
import { RELEASED_KIT_VERSIONS } from "./kit";
import type { PageBuildError } from "./errors";

/** The file of a Page that says what it is. */
export const PAGE_MANIFEST_FILE = "app.yaml";
/** A manifest is a few lines. One larger than this is refused before it is parsed. */
export const PAGE_MANIFEST_MAX_BYTES = 64 * 1024;
/** How many connections, Data Stores, actions or hosts one manifest lists. */
const MANIFEST_MAX_LIST_ENTRIES = 100;

const name = z.string().min(1).max(120);
const identifier = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,62}$/u, "lowercase letters, digits, '-' and '_', at most 63");
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
  dataStores: z
    .array(dataStoreReferenceSchema)
    .max(MANIFEST_MAX_LIST_ENTRIES)
    .superRefine((stores, context) => {
      const seen = new Set<string>();
      for (const { name: store } of stores) {
        if (seen.has(store)) {
          context.addIssue({
            code: "custom",
            message: `lists the Data Store '${store}' twice`
          });
        }
        seen.add(store);
      }
    })
    .optional(),
  actions: z.array(actionSchema).max(MANIFEST_MAX_LIST_ENTRIES).optional(),
  externalHosts: z.array(externalHostSchema).max(MANIFEST_MAX_LIST_ENTRIES).optional()
});

export type PageManifest = z.infer<typeof pageManifestSchema>;

/**
 * The manifest as a build writes it: the author's, with the entry and the pages it derived and
 * with the actions as they were compiled from their files.
 */
export const builtPageManifestSchema = pageManifestSchema
  .extend({
    actions: z.array(compiledAppActionSchema).max(MANIFEST_MAX_LIST_ENTRIES).optional(),
    entry: z.string().refine((value) => fileSetPathIssue(value) === undefined, {
      message: "a path of a built file"
    }),
    pages: z
      .array(z.strictObject({ path: z.string().min(1).max(512) }))
      .max(1000)
      .optional()
  })
  // A build is not trusted to have checked this: an action reaches the Connection or the Data
  // Store the manifest lists.
  .superRefine((manifest, context) => {
    const stores = new Set((manifest.dataStores ?? []).map((store) => store.name));
    const connections = new Set(manifest.connections ?? []);
    for (const action of manifest.actions ?? []) {
      // A Workflow is no part of the manifest: the action file names it, and each call asks
      // whether it exists.
      if (action.kind === "workflow") continue;
      const reached =
        action.kind === "sql"
          ? { listed: stores.has(action.dataStore), what: `Data Store '${action.dataStore}'` }
          : {
              listed: connections.has(action.connection),
              what: `Connection '${action.connection}'`
            };
      if (!reached.listed) {
        context.addIssue({
          code: "custom",
          path: ["actions"],
          message: `the action '${action.name}' reaches the ${reached.what}, which '${action.kind === "sql" ? "dataStores" : "connections"}' does not list`
        });
      }
    }
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
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("The manifest is not UTF-8 text.");
  }
  const read = readYamlData(text, PAGE_MANIFEST_FILE);
  if (!read.ok) {
    return fail(read.issue.message, read.issue.line);
  }
  const value = read.value;
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
    return `Unknown key${issue.keys.length > 1 ? "s" : ""} ${issue.keys.map((key) => `'${key}'`).join(", ")}${where}. A manifest holds id, name, description, icon, kit, entry, connections, dataStores, actions and externalHosts.${derived}`;
  }
  const key = issue.path.length > 0 ? `'${issue.path.join(".")}'` : "The manifest";
  return `${key}: ${issue.message}`;
}
