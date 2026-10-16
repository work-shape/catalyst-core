import { fileSetPathIssue, OPERATION_EFFECTS, readYamlData } from "@work-shape/catalyst-core";
import { z } from "zod";
import {
  compiledAppActionSchema,
  dataStoreReferenceSchema,
  externalHostSchema
} from "./action-input";
import type { PageBuildError } from "./errors";
import { RELEASED_KIT_VERSIONS } from "./kit";

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

/** Refuses a list that names one entry twice, by the key `keyOf` reads from each. */
function eachOnce<Entry>(what: string, keyOf: (entry: Entry) => string) {
  return (entries: Entry[], context: z.RefinementCtx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = keyOf(entry);
      if (seen.has(key)) {
        context.addIssue({ code: "custom", message: `lists ${what} '${key}' twice` });
      }
      seen.add(key);
    }
  };
}

const actionSchema = z.strictObject({
  name: identifier,
  file: relativeFile.optional(),
  effect: z.enum(OPERATION_EFFECTS),
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
    .superRefine(eachOnce("the Data Store", (store) => store.name))
    .optional(),
  actions: z.array(actionSchema).max(MANIFEST_MAX_LIST_ENTRIES).optional(),
  externalHosts: z
    .array(externalHostSchema)
    .max(MANIFEST_MAX_LIST_ENTRIES)
    .superRefine(eachOnce("the host", (host) => host))
    .optional()
});

export type PageManifest = z.infer<typeof pageManifestSchema>;

// Keys that a coming part of Apps will give a meaning. Each is refused with what brings it, so
// a manifest or an action file that names one never builds and then half works: `rights` at the
// top and `requires` at the top or on an action wait on rights inside Apps, which are not
// decided yet; the `code` action with its `reads` and `writes` is APP-12 of the build plan.
const RESERVED_RIGHTS =
  "Rights inside Apps are not yet decided, so no slice brings this key yet. An App runs with the rights of whoever looks at it.";
const RESERVED_CODE_ACTION =
  "A code action, with its 'reads' and 'writes', arrives with APP-12. Reach a Connection through a connection action, a Data Store through an sql action, and start a Workflow through a workflow action.";

/** The keys at the top of `app.yaml` that are reserved, with why each is refused. */
const RESERVED_MANIFEST_KEYS: Readonly<Record<string, string>> = {
  rights: RESERVED_RIGHTS,
  requires: RESERVED_RIGHTS
};

/** The keys of an action that are reserved for the `code` action. */
const RESERVED_CODE_ACTION_KEYS = ["reads", "writes"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One sentence that names reserved keys, and why. */
function reservedSentence(named: readonly string[], why: string): string {
  return `${named.join(", ")} ${named.length === 1 ? "is" : "are"} reserved. ${why}`;
}

/**
 * Why an action, as a line of the manifest or as its action file, names a reserved key: the
 * kind `code` or its `reads` or `writes`, or `requires`. Nothing for any other action.
 */
export function reservedActionKeyMessage(action: unknown): string | undefined {
  if (!isRecord(action)) return undefined;
  const code = [
    ...(action.kind === "code" ? ["kind: code"] : []),
    ...RESERVED_CODE_ACTION_KEYS.filter((key) => key in action).map((key) => `'${key}'`)
  ];
  const sentences = [
    ...(code.length > 0 ? [reservedSentence(code, RESERVED_CODE_ACTION)] : []),
    ...("requires" in action ? [reservedSentence(["'requires'"], RESERVED_RIGHTS)] : [])
  ];
  return sentences.length === 0 ? undefined : sentences.join(" ");
}

/** The refusals of the reserved keys a manifest names, each with what brings the key. */
function reservedManifestKeyErrors(manifest: unknown): PageBuildError[] {
  if (!isRecord(manifest)) return [];
  const errors: PageBuildError[] = Object.entries(RESERVED_MANIFEST_KEYS).flatMap(([key, why]) =>
    key in manifest
      ? [
          {
            file: PAGE_MANIFEST_FILE,
            code: "key_reserved" as const,
            message: reservedSentence([`'${key}'`], why)
          }
        ]
      : []
  );
  const actions = Array.isArray(manifest.actions) ? manifest.actions : [];
  for (const action of actions) {
    const message = reservedActionKeyMessage(action);
    if (message === undefined) continue;
    const name = isRecord(action) && typeof action.name === "string" ? action.name : undefined;
    errors.push({
      file: PAGE_MANIFEST_FILE,
      code: "key_reserved",
      message: `${name === undefined ? "An action" : `The action '${name}'`}: ${message}`
    });
  }
  return errors;
}

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
  const read = readYamlData(text, PAGE_MANIFEST_FILE, { refuseAliases: true });
  if (!read.ok) {
    return fail(read.issue.message, read.issue.line);
  }
  const value = read.value;
  const reserved = reservedManifestKeyErrors(value);
  if (reserved.length > 0) {
    return { status: "errors", errors: reserved };
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
    const holds =
      issue.path[0] === "actions"
        ? "A line under 'actions' holds name, file, effect, policy and connection. An action file 'actions/<name>.action.yaml' says itself what it calls and needs no line; a statement 'actions/<name>.sql' needs one with name, file and effect."
        : `A manifest holds id, name, description, icon, kit, entry, connections, dataStores, actions and externalHosts.${derived}`;
    return `Unknown key${issue.keys.length > 1 ? "s" : ""} ${issue.keys.map((key) => `'${key}'`).join(", ")}${where}. ${holds}`;
  }
  const key = issue.path.length > 0 ? `'${issue.path.join(".")}'` : "The manifest";
  return `${key}: ${issue.message}`;
}
