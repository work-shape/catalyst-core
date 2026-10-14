import { z } from "zod";
import { connectionConfigSchema } from "@vivd-catalyst/config-schema";
import {
  CONNECTION_CREDENTIAL_WORDS,
  CONNECTION_MAX_ACCEPTED_OPERATIONS,
  CONNECTION_NAME_MAX_LENGTH,
  findConnectorTypeIssues,
  type AssetValidationIssue,
  type ConnectionOperationConfig,
  type ConnectorTypeRegistry,
  type JsonObject
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

// The agent's draft of the tools of a REST API, as a card in the conversation (CS-5c). The agent
// reads a vendor's API description and declares the operations; this tool checks them as a save
// of the Connection would, and answers the checked draft, which the conversation shows as a card.
// The card's button opens the Connection's approval list with the draft, and the person's
// confirmation there is the save. The tool saves nothing, reads nothing of the instance and
// never holds a key: the draft carries the Connection's name, address and the names of its
// fixed headers, never a header's value, and a declaration the first cut refuses (a method
// other than GET, the effect `changing`, a header or parameter that can carry a credential)
// answers its refusal and no card.

export const CONNECTION_DRAFT_TOOL_NAME = "platform.connections.draft_tools";

/** How many fixed headers a draft names: the type's own bound. */
const DRAFT_HEADERS_MAX = 16;

/**
 * Parameter names that hand a credential to the request: a draft refuses them, as an agent
 * would fill such a parameter with a key at every call. A name is read as its words, split at
 * case changes, digits and separators: `refresh_token` is `refresh token`, `APIKey` is
 * `api key`. It names a credential where a word is one of the release's credential words or
 * of the words below, or such a word fused to one of the qualifiers, as `authkey`. A word
 * never matches inside another: `secretary` and `author` stay allowed.
 */
const CREDENTIAL_PARAMETER_WORDS: ReadonlySet<string> = new Set([
  ...CONNECTION_CREDENTIAL_WORDS,
  "authorization",
  "bearer",
  "credential",
  "credentials",
  "jwt",
  "keys",
  "pass",
  "passphrase",
  "passwd",
  "pwd",
  "secrets",
  "sig",
  "signature",
  "tokens"
]);
/** Words a credential word is fused to in one word, as `apikey` or `accesstoken`. */
const CREDENTIAL_QUALIFIERS = [
  "access",
  "api",
  "auth",
  "client",
  "id",
  "license",
  "private",
  "refresh",
  "session",
  "subscription",
  "user"
];
/**
 * The words before a credential word that make it a cursor, not a credential: `pageToken`,
 * `nextToken` and `sortKey` stay allowed. Fused as well: `pagetoken`.
 */
const CURSOR_QUALIFIERS = ["page", "next", "cursor", "continuation", "sync", "sort"];

/** A parameter's name as its words, lower case. */
function wordsOf(name: string): string[] {
  return (name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/gu) ?? []).map((word) =>
    word.toLowerCase()
  );
}

/**
 * Whether one word is two fused, a credential word and a qualifier or another credential word,
 * either way round: `authkey`, `apitoken`, `sessionid`. `pagetoken` is a cursor.
 */
function isFusedCredentialWord(word: string): boolean {
  const fusable = (part: string): boolean =>
    CREDENTIAL_PARAMETER_WORDS.has(part) || CREDENTIAL_QUALIFIERS.includes(part);
  for (let at = 1; at < word.length; at += 1) {
    const [first, second] = [word.slice(0, at), word.slice(at)];
    if (CURSOR_QUALIFIERS.includes(first)) continue;
    if (CREDENTIAL_PARAMETER_WORDS.has(second) && fusable(first)) return true;
    if (CREDENTIAL_PARAMETER_WORDS.has(first) && fusable(second)) return true;
  }
  return false;
}

/** Whether a parameter's name names a credential, by the lists above. */
function isCredentialParameterName(name: string): boolean {
  const words = wordsOf(name);
  return words.some((word, index) =>
    CREDENTIAL_PARAMETER_WORDS.has(word)
      ? !CURSOR_QUALIFIERS.includes(words[index - 1] ?? "")
      : isFusedCredentialWord(word)
  );
}

/**
 * The keywords of a parameter's schema that carry a value of the draft's own: whatever they
 * hold is saved with the Connection and read by the agent, yet the approval list shows none of
 * it. A draft refuses them.
 */
const DRAFT_VALUE_KEYWORDS = ["default", "const", "examples", "example"];

/** The value keywords anywhere in a schema, by their path below it. */
function valueKeywordPaths(schema: unknown, path: string[] = []): string[][] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => valueKeywordPaths(item, [...path, String(index)]));
  }
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) => [
    ...(DRAFT_VALUE_KEYWORDS.includes(key) ? [[...path, key]] : []),
    ...valueKeywordPaths(value, [...path, key])
  ]);
}

/** The Connection a draft is for, as the card shows it and a new Connection is filled with. */
interface ConnectionDraftTarget {
  /** The Connection's id. */
  name: string;
  /** Its name in words. */
  title: string;
  baseUrl: string;
  /** The fixed headers the API needs, by name. Their values are typed by a person. */
  headerNames: string[];
}

/** One operation of a draft: its declaration as the check accepted it, and its effect. */
type DraftedOperation = Pick<
  ConnectionOperationConfig,
  "name" | "effect" | "title" | "description" | "method" | "path" | "pathParams" | "query"
>;

/** The checked draft: what the card shows and the approval list starts with. */
interface ConnectionToolsDraft {
  connection: ConnectionDraftTarget;
  operations: DraftedOperation[];
}

/** One thing a draft is refused for, by the field of the tool's input it is about. */
interface DraftIssue {
  path: string;
  message: string;
  code?: string;
}

const parameterSchema = z.object({
  schema: z
    .record(z.string(), z.unknown())
    .describe(
      "The JSON Schema of the value. Its 'type' is string, integer or number; a query parameter may also be boolean. No 'default', 'const', 'examples' or 'example': a draft carries no value of its own."
    ),
  description: z.string().optional().describe("What the value is, for whoever fills it."),
  required: z
    .boolean()
    .optional()
    .describe(
      "For a query parameter only: true where the API needs it. A path parameter is always required."
    )
});

const operationSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "The operation's id: letters, digits, '_' or '-', starting with a letter, such as 'list_clients'. The tool is called connection.<connection>.<name>."
    ),
  title: z
    .string()
    .optional()
    .describe("The name in words a person reads in the list, such as 'List customers'."),
  description: z
    .string()
    .describe(
      "What the operation reads and when an agent calls it, in one or two sentences. An agent that carries the tool reads it."
    ),
  method: z.string().describe("GET. This first cut reads only; any other method is refused."),
  path: z
    .string()
    .describe(
      "The path relative to the base address, from '/', with each path parameter as {name}, such as '/clients/{clientId}/fiscal-years'. No query: a query value is a declared parameter."
    ),
  pathParams: z
    .record(z.string(), parameterSchema)
    .optional()
    .describe("Every {name} of the path, by name."),
  query: z
    .record(z.string(), parameterSchema)
    .optional()
    .describe("The query parameters, by name."),
  effect: z
    .enum(["reading", "changing"])
    .describe("reading. This first cut reads only; 'changing' is refused.")
});

const inputSchema = z.object({
  connection: z
    .string()
    .min(1)
    .max(CONNECTION_NAME_MAX_LENGTH)
    .describe(
      "The id of the Connection the tools are for, such as 'crm': the one the request names, or a new one in lowercase letters, digits and hyphens."
    ),
  title: z.string().min(1).max(120).describe("The Connection's name in words, such as 'CRM'."),
  baseUrl: z
    .string()
    .min(1)
    .describe(
      "The address every request starts with, such as 'https://crm.example/api/v1'. No user name, password, query or fragment."
    ),
  headerNames: z
    .array(z.string())
    .max(DRAFT_HEADERS_MAX)
    .optional()
    .describe(
      "The names of fixed headers the API needs on every request that carry no credential, such as 'x-tenant-id'. Names only: a person types their values. A header that carries a key is never one of them: the person enters the key on the Connection's page."
    ),
  operations: z
    .array(operationSchema)
    .min(1)
    .max(CONNECTION_MAX_ACCEPTED_OPERATIONS)
    .describe("The operations to propose, each one GET request that only reads.")
});

const declaredParameterSchema = z.object({
  schema: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
  required: z.boolean().optional()
});

const outputSchema = z.object({
  connection: z.object({
    name: z.string(),
    title: z.string(),
    baseUrl: z.string(),
    headerNames: z.array(z.string())
  }),
  operations: z.array(
    z.object({
      name: z.string(),
      effect: z.enum(["reading", "changing"]),
      title: z.string().optional(),
      description: z.string().optional(),
      method: z.string().optional(),
      path: z.string().optional(),
      pathParams: z.record(z.string(), declaredParameterSchema).optional(),
      query: z.record(z.string(), declaredParameterSchema).optional()
    })
  )
});

type DraftInput = z.infer<typeof inputSchema>;

/**
 * The field of the tool's input an issue of the Connection a draft stands for is about: its
 * settings are the address and the header names, its name the Connection's id.
 */
function inputPathOf(path: readonly PropertyKey[]): string {
  const [first, second] = path.map(String);
  if (first === "settings") return second === "headers" ? "headerNames" : "baseUrl";
  if (first === "name") return "connection";
  if (first === "displayName") return "title";
  return path.map(String).join(".");
}

function draftIssue(issue: AssetValidationIssue): DraftIssue {
  return {
    path: inputPathOf(issue.path ?? []),
    message: issue.message,
    ...(issue.code === undefined ? {} : { code: issue.code })
  };
}

/**
 * The operation as a draft carries it: its declaration and effect, nothing the approval sets.
 * `scope` is no part of it: the check refuses it until SCOPE-2.
 */
function draftedOperation({
  name,
  effect,
  title,
  description,
  method,
  path,
  pathParams,
  query
}: ConnectionOperationConfig): DraftedOperation {
  return { name, effect, title, description, method, path, pathParams, query };
}

/**
 * Checks a draft as a save of a new Connection of the type would check it: the definition's
 * shape, then the type's settings and declarations. A header is checked by its name with an
 * empty value: the draft never carries one. Answers the checked draft, or every issue.
 */
function checkConnectionDraft(
  input: { connectorTypes: ConnectorTypeRegistry; connectorType: string; ownerPrincipalId: string },
  draft: DraftInput
): { ok: true; draft: ConnectionToolsDraft } | { ok: false; issues: DraftIssue[] } {
  const headerNames = draft.headerNames ?? [];
  const candidate = {
    name: draft.connection,
    displayName: draft.title,
    connectorType: input.connectorType,
    ownerPrincipalId: input.ownerPrincipalId,
    settings: {
      baseUrl: draft.baseUrl,
      ...(headerNames.length === 0
        ? {}
        : { headers: Object.fromEntries(headerNames.map((name) => [name, ""])) })
    },
    authScheme: "none",
    operations: draft.operations.map((operation) => ({ ...operation, exposure: [] })),
    origin: "runtime"
  };
  const parsed = connectionConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) =>
        draftIssue({ message: issue.message, path: issue.path })
      )
    };
  }
  const issues = [
    ...findConnectorTypeIssues(input.connectorTypes, parsed.data),
    ...parameterIssues(draft)
  ];
  if (issues.length > 0) return { ok: false, issues: issues.map(draftIssue) };
  return {
    ok: true,
    draft: {
      connection: {
        name: parsed.data.name,
        title: parsed.data.displayName,
        baseUrl: draft.baseUrl,
        headerNames
      },
      operations: parsed.data.operations.map(draftedOperation)
    }
  };
}

/**
 * The parameters of a draft that name a credential, and the values its schemas carry. A save
 * refuses neither; a draft does, as the agent drafting never handles a key, and the person
 * approves only what the approval list shows: a key goes through the Connection's auth scheme.
 */
function parameterIssues(draft: DraftInput): AssetValidationIssue[] {
  return draft.operations.flatMap((operation, index) =>
    (["pathParams", "query"] as const).flatMap((field) =>
      Object.entries(operation[field] ?? {}).flatMap(([name, parameter]) => [
        ...(isCredentialParameterName(name)
          ? [
              {
                message: `The parameter '${name}' can carry a credential. A key is entered on the Connection's page and sent by its auth scheme, never as a parameter`,
                path: ["operations", index, field, name],
                code: "credential_in_parameter"
              }
            ]
          : []),
        ...valueKeywordPaths(parameter.schema).map((keywordPath) => ({
          message: `A draft carries no value the approval list does not show: remove '${keywordPath.join(".")}' from the schema`,
          path: ["operations", index, field, name, "schema", ...keywordPath],
          code: "value_in_draft"
        }))
      ])
    )
  );
}

/**
 * The tool an agent drafts the tools of a REST API with, for the Connector type `connectorType`
 * of `connectorTypes`. It is offered where the module `connections` is on.
 */
export function createConnectionDraftTool(input: {
  connectorTypes: ConnectorTypeRegistry;
  connectorType: string;
}): AnyToolDefinition {
  return defineTool({
    name: CONNECTION_DRAFT_TOOL_NAME,
    effect: "reading",
    description: [
      "Propose the tools of a REST API Connection for a person to approve. Use it when the person asks you to draft the tools of a REST API, such as from the API's OpenAPI description, which you may read with web_fetch.",
      "Write each operation as one GET request that only reads: its name, a description an agent can act on, the path with its parameters and the query parameters, each with a JSON Schema.",
      "The tool checks the operations as a save of the Connection would, and answers either every issue, which you fix before you call it again, or the draft, which the person sees as a card in this conversation. From the card they open the Connection's approval list and approve the tools; nothing is saved before that, and you never save a Connection.",
      "Never ask for a key and never put one into the draft: the person enters it on the Connection's page. A header or parameter that carries a credential, a value in a parameter's schema ('default', 'const', 'examples'), a method other than GET and the effect 'changing' are refused.",
      "After a draft, tell the person in one sentence to review the tools on the card and approve what they need."
    ].join(" "),
    inputSchema,
    outputSchema,
    execute(draft, context) {
      const checked = checkConnectionDraft({ ...input, ownerPrincipalId: context.user.id }, draft);
      const auditSummary = {
        action: CONNECTION_DRAFT_TOOL_NAME,
        subject: draft.connection,
        metadata: { operationCount: draft.operations.length }
      };
      if (!checked.ok) {
        const details: JsonObject = {
          issues: checked.issues.map((issue) => ({ ...issue }))
        };
        return {
          status: "failed",
          error: {
            code: "validation_failed",
            message: `The draft is refused, so no card shows. Fix each issue and call ${CONNECTION_DRAFT_TOOL_NAME} again: ${checked.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ")}`,
            details
          },
          auditSummary: { ...auditSummary, metadata: { ...auditSummary.metadata, refused: true } }
        };
      }
      return toolSuccess(checked.draft, { auditSummary });
    }
  });
}
