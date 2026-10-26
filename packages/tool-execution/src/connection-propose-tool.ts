import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  CATALOGUE_PARTS,
  CONNECTION_CREDENTIAL_MODES,
  CONNECTOR_TOKEN_AUTH_METHODS,
  CONNECTION_PROPOSAL_STATES,
  CONNECTION_PROPOSAL_BINDING_STATES,
  type CataloguePart,
  type ConnectionCredentialMode,
  type ConnectionProposalBindingState,
  CONNECTION_NAME_MAX_LENGTH,
  CONNECTION_MAX_ACCEPTED_OPERATIONS,
  OPERATION_EFFECTS,
  findConnectorTypeIssues,
  type AssetValidationIssue,
  type ConnectorTypeRegistry,
  type ToolExecutionContext,
  type JsonObject
} from "@work-shape/catalyst-core";
import {
  defineTool,
  deriveInputJsonSchema,
  toolSuccess,
  type AnyToolDefinition
} from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import {
  checkConnectionDraft,
  connectionDraftOperationSchema,
  connectionDraftParameterSchema,
  CONNECTION_DRAFT_TOOL_NAME
} from "./connection-draft-tool";
import { CONNECTION_OFFER_TOOL_NAME } from "./connection-offer-tool";

// Read-only proposals: instance configuration and setup state only. No provider calls or writes.

export const CONNECTION_PROPOSE_TOOL_NAME = "platform.connections.propose";

/** The types the New connection dialog takes an address and a key for. */
const MCP = "mcp";
const HTTP_API = "http_api";

/** How many fixed headers a proposal names: the type's own bound. */
const PROPOSAL_HEADERS_MAX = 16;

/** A header name as HTTP spells it. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;

// Legacy draft_tools strips unknown members; a whole proposal refuses them at every field boundary.
const proposalOperationSchema = connectionDraftOperationSchema.strict().extend({
  pathParams: z.record(z.string(), connectionDraftParameterSchema.strict()).optional(),
  query: z.record(z.string(), connectionDraftParameterSchema.strict()).optional()
});

const customInputSchema = z.strictObject({
  authScheme: z.enum(["none", "bearer", "header", "oauth", "oauth_client"]).optional(),
  credentialMode: z.enum(CONNECTION_CREDENTIAL_MODES).optional(),
  oauth: z
    .strictObject({
      authorizationUrl: z.string().optional(),
      tokenUrl: z.string(),
      revocationUrl: z.string().optional(),
      clientId: z.string(),
      scopes: z.array(z.string()).optional(),
      tokenAuthMethod: z.enum(CONNECTOR_TOKEN_AUTH_METHODS).optional()
    })
    .optional(),
  operations: z.array(proposalOperationSchema).max(CONNECTION_MAX_ACCEPTED_OPERATIONS).optional(),
  connectorType: z
    .string()
    .min(1)
    .describe(
      "'mcp' for a remote MCP server, 'http_api' for a REST API, or another Connector type of this instance."
    ),
  connection: z
    .string()
    .min(1)
    .max(CONNECTION_NAME_MAX_LENGTH)
    .describe("The new Connection's id in lowercase letters, digits and hyphens."),
  title: z.string().min(1).max(120).describe("Its name in words."),
  url: z
    .string()
    .min(1)
    .optional()
    .describe(
      "For 'mcp' the server's address, for 'http_api' the address every request starts with: https, without user name, password, query or fragment. Left out for another type."
    ),
  keyHeader: z
    .string()
    .optional()
    .describe(
      "For 'mcp' or 'http_api': the header a key goes in, such as 'x-api-key', where it is no bearer token. The name only."
    ),
  headerNames: z
    .array(z.string())
    .max(PROPOSAL_HEADERS_MAX)
    .optional()
    .describe("For 'http_api': fixed headers that carry no credential, such as 'x-tenant-id'."),
  testPath: z
    .string()
    .min(1)
    .optional()
    .describe("For 'http_api': a GET path that answers 2xx only with a valid key, such as '/me'.")
});

const entrySchema = z.strictObject({ id: z.string().min(1), part: z.enum(CATALOGUE_PARTS) });
const inputSchema = z.union([z.strictObject({ entry: entrySchema }), customInputSchema]);

// What the model is shown: one object, since some model providers refuse a union at the root of
// a tool's input, and the operations without the field notes of draft_tools, said once instead.
// The union above still checks every call.
const modelParameterSchema = z.strictObject({
  schema: z.record(z.string(), z.unknown()),
  description: z.string().optional(),
  required: z.boolean().optional().describe("Query parameters only; never on a path parameter.")
});
const modelInputSchema = customInputSchema.extend({
  entry: entrySchema.optional().describe("An offered catalogue entry, given alone."),
  connectorType: customInputSchema.shape.connectorType.optional(),
  connection: customInputSchema.shape.connection.optional(),
  title: customInputSchema.shape.title.optional(),
  operations: z
    .array(
      z.strictObject({
        name: z.string(),
        title: z.string().optional(),
        description: z.string(),
        method: z.string(),
        path: z.string(),
        pathParams: z.record(z.string(), modelParameterSchema).optional(),
        query: z.record(z.string(), modelParameterSchema).optional(),
        effect: z.enum(OPERATION_EFFECTS)
      })
    )
    .max(CONNECTION_MAX_ACCEPTED_OPERATIONS)
    .optional()
    .describe(
      "For 'http_api': GET operations that only read, effect reading. A path starts with '/', has no query and declares each {name} in pathParams. A parameter's schema has type string, integer or number (a query one also boolean or an array of those) and no fixed value: no default, const, example or one-value enum."
    )
});

/** Minimal, read-only catalogue projection supplied by the instance. Hosts stay internal. */
export interface ConnectionProposalCatalogueEntry {
  id: string;
  title: string;
  category: string;
  parts: {
    part: CataloguePart;
    connectorType: string;
    name: string;
    credentialModes: ConnectionCredentialMode[];
    defaultCredentialMode: ConnectionCredentialMode;
    hosts: string[];
    connection?: {
      name: string;
      clientSecretSet: boolean;
      credentialMode: ConnectionCredentialMode;
      bindingState?: ConnectionProposalBindingState;
    };
  }[];
}

export interface ConnectionProposalCatalogue {
  read(context: ToolExecutionContext): Promise<ConnectionProposalCatalogueEntry[]>;
  /**
   * Whether the person may set the Connection of this name up: `connection.write` on it where
   * it exists, on the instance where it would be made.
   */
  mayWrite(context: ToolExecutionContext, connectionName: string): Promise<boolean>;
}

const outputSchema = z.object({
  entry: entrySchema.optional(),
  state: z.enum(CONNECTION_PROPOSAL_STATES).optional(),
  mayWrite: z.boolean().optional(),
  bindingState: z.enum(CONNECTION_PROPOSAL_BINDING_STATES).optional(),
  operations: z.array(proposalOperationSchema).optional(),
  connection: z.object({
    authScheme: customInputSchema.shape.authScheme,
    credentialMode: customInputSchema.shape.credentialMode,
    oauth: customInputSchema.shape.oauth,
    connectorType: z.string(),
    name: z.string(),
    title: z.string(),
    url: z.string().optional(),
    keyHeader: z.string().optional(),
    headerNames: z.array(z.string()),
    testPath: z.string().optional()
  })
});

type ProposalInput = z.infer<typeof customInputSchema>;
type Proposal = z.infer<typeof outputSchema>;

interface ProposalIssue {
  path: string;
  message: string;
  code?: string;
}

/** The field of the tool's input an issue of the candidate Connection is about. */
function inputPathOf(path: readonly PropertyKey[]): string {
  const [first, second] = path.map(String);
  if (first === "settings") {
    if (second === "headers") return "headerNames";
    if (second === "testPath") return "testPath";
    if (second === "headerName") return "keyHeader";
    if (second === "oauth") return path.slice(1).map(String).join(".");
    return "url";
  }
  if (first === "name") return "connection";
  if (first === "displayName") return "title";
  return path.map(String).join(".");
}

function proposalIssue(issue: AssetValidationIssue): ProposalIssue {
  return {
    path: inputPathOf(issue.path ?? []),
    message: issue.message,
    ...(issue.code === undefined ? {} : { code: issue.code })
  };
}

/**
 * An address that could carry a credential, or one no dialog connects: not https, with a user
 * name or password, a query or a fragment.
 */
function addressIssues(url: string, path = "url"): ProposalIssue[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ path, message: "The address is no URL" }];
  }
  const issues: ProposalIssue[] = [];
  if (parsed.protocol !== "https:") {
    issues.push({ path, message: "The address starts with https://" });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    issues.push({
      path,
      message: "The address carries no user name or password: the person enters the key",
      code: "credential_in_url"
    });
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    issues.push({
      path,
      message:
        "The address carries no query or fragment, which can hold a key: the person enters the key in the dialog",
      code: "credential_in_url"
    });
  }
  return issues;
}

/** The settings of the candidate Connection a type with an address takes. */
function addressSettings(input: ProposalInput, url: string): Record<string, unknown> {
  const keyHeader = input.keyHeader === undefined ? {} : { headerName: input.keyHeader };
  if (input.connectorType === MCP) return { url, ...keyHeader };
  const headerNames = input.headerNames ?? [];
  return {
    baseUrl: url,
    ...(input.oauth === undefined ? {} : { oauth: input.oauth }),
    ...(input.testPath === undefined ? {} : { testPath: input.testPath }),
    ...(headerNames.length === 0
      ? {}
      : { headers: Object.fromEntries(headerNames.map((name) => [name, ""])) }),
    ...keyHeader
  };
}

/**
 * Checks a proposal as a save of the new Connection would check what it names: the id and
 * name, and for a type with an address, its settings with an empty value for each header. A
 * type with a form of its own is checked by the form.
 */
function checkProposal(
  connectorTypes: ConnectorTypeRegistry,
  ownerPrincipalId: string,
  input: ProposalInput,
  entries: ConnectionProposalCatalogueEntry[]
): { ok: true; proposal: Proposal } | { ok: false; issues: ProposalIssue[] } {
  const type = connectorTypes.get(input.connectorType);
  if (type === undefined) {
    return {
      ok: false,
      issues: [
        {
          path: "connectorType",
          message: `This instance connects no type '${input.connectorType}'. Its types: ${connectorTypes.types.map((entry) => entry.type).join(", ")}`
        }
      ]
    };
  }
  const takesAddress = input.connectorType === MCP || input.connectorType === HTTP_API;
  const issues: ProposalIssue[] = [];
  if (takesAddress && input.url === undefined) {
    issues.push({ path: "url", message: "Name the address to connect" });
  }
  if (!takesAddress) {
    for (const field of [
      "url",
      "keyHeader",
      "headerNames",
      "testPath",
      "oauth",
      "authScheme",
      "credentialMode",
      "operations"
    ] as const) {
      if (input[field] !== undefined) {
        issues.push({
          path: field,
          message: `A '${input.connectorType}' form asks for this itself`
        });
      }
    }
  }
  if (input.connectorType !== HTTP_API) {
    for (const field of ["headerNames", "testPath", "oauth", "operations"] as const) {
      if (takesAddress && input[field] !== undefined) {
        issues.push({ path: field, message: "Only a REST API ('http_api') takes this" });
      }
    }
  }
  if (input.keyHeader !== undefined && !HEADER_NAME.test(input.keyHeader)) {
    issues.push({ path: "keyHeader", message: "The header name is no HTTP header name" });
  }
  if (input.url !== undefined && takesAddress) issues.push(...addressIssues(input.url));
  for (const [path, url] of Object.entries({
    url: input.url,
    "oauth.tokenUrl": input.oauth?.tokenUrl,
    "oauth.authorizationUrl": input.oauth?.authorizationUrl,
    "oauth.revocationUrl": input.oauth?.revocationUrl
  })) {
    if (url === undefined) continue;
    if (path !== "url") issues.push(...addressIssues(url, path));
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    const covered = entries.find((entry) =>
      entry.parts.some((part) =>
        part.hosts.some((target) => {
          try {
            return new URL(`https://${target}`).hostname.toLowerCase() === host;
          } catch {
            return false;
          }
        })
      )
    );
    if (covered)
      issues.push({
        path,
        code: "entry_covers_host",
        message: `Catalogue entry '${covered.id}' covers this host. Propose that entry instead.`
      });
  }
  if (
    input.operations !== undefined &&
    input.connectorType === HTTP_API &&
    input.url !== undefined
  ) {
    const draft = checkConnectionDraft(
      { connectorTypes, connectorType: HTTP_API, ownerPrincipalId },
      {
        connection: input.connection,
        title: input.title,
        baseUrl: input.url,
        headerNames: input.headerNames,
        testPath: input.testPath,
        operations: input.operations
      }
    );
    if (!draft.ok) issues.push(...draft.issues);
  }
  const candidate = {
    name: input.connection,
    displayName: input.title,
    connectorType: input.connectorType,
    ownerPrincipalId,
    settings: takesAddress && input.url !== undefined ? addressSettings(input, input.url) : {},
    authScheme: input.authScheme ?? (input.keyHeader === undefined ? "none" : "header"),
    credentialMode: input.credentialMode ?? "shared",
    operations: [],
    origin: "runtime"
  };
  const parsed = connectionConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    issues.push(
      ...parsed.error.issues.map((issue) =>
        proposalIssue({ message: issue.message, path: issue.path })
      )
    );
  } else if (takesAddress && issues.length === 0) {
    issues.push(...findConnectorTypeIssues(connectorTypes, parsed.data).map(proposalIssue));
  }
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    proposal: {
      ...(input.operations === undefined ? {} : { operations: input.operations }),
      connection: {
        ...(input.authScheme === undefined ? {} : { authScheme: input.authScheme }),
        ...(input.credentialMode === undefined ? {} : { credentialMode: input.credentialMode }),
        ...(input.oauth === undefined ? {} : { oauth: input.oauth }),
        connectorType: input.connectorType,
        name: input.connection,
        title: input.title,
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.keyHeader === undefined ? {} : { keyHeader: input.keyHeader }),
        headerNames: input.headerNames ?? [],
        ...(input.testPath === undefined ? {} : { testPath: input.testPath })
      }
    }
  };
}

/** The tool an agent proposes a new Connection with. Offered where the module `connections` is on. */
export function createConnectionProposeTool(input: {
  connectorTypes: ConnectorTypeRegistry;
  catalogue?: ConnectionProposalCatalogue;
}): AnyToolDefinition {
  return defineTool({
    name: CONNECTION_PROPOSE_TOOL_NAME,
    title: { en: "Propose a connection", de: "Verbindung vorschlagen" },
    summary: {
      en: "Opens the New connection dialog, filled in, for the person to connect.",
      de: "Öffnet den Dialog „Neue Verbindung“ ausgefüllt, damit die Person verbindet."
    },
    group: "platform",
    icon: "connection",
    effect: "reading",
    description: [
      "Propose a new Connection to an outside system: a remote MCP server ('mcp'), a REST API ('http_api') or another Connector type of the instance.",
      "Read catalogue.entries in platform.context first. If an entry fits, pass only entry: { id, part }; do not web-search the provider or draft tools against its hosts. Otherwise name the type, an id, a title and, for 'mcp' or 'http_api', the url, authScheme, credentialMode (user for mail, calendar and personal files), OAuth endpoints, scopes and public clientId, and GET read operations.",
      "Issues in the answer are fixed before you call again. A passing proposal shows as a card; the person's screen opens the New connection dialog filled with it, where they enter the key or sign in and press Connect. Nothing is saved before.",
      "Never ask for a key, token or password, nor put one into the proposal: say in one sentence that they enter it in the dialog. Never ask a question in the same turn as an approval card. Never say a service is unsupported: build the custom path and name the one step you cannot do.",
      "A message from the person says when it is connected and which tools they approved. Then draft any missing reads of a REST API with " +
        CONNECTION_DRAFT_TOOL_NAME +
        ", offer the tools with " +
        CONNECTION_OFFER_TOOL_NAME +
        " where you hold it, and build what they asked for."
    ].join(" "),
    inputSchema,
    inputJsonSchema: deriveInputJsonSchema(modelInputSchema),
    outputSchema,
    async execute(proposal, context) {
      const entries = (await input.catalogue?.read(context)) ?? [];
      const mayWrite = async (connectionName: string) =>
        (await input.catalogue?.mayWrite(context, connectionName)) ?? false;
      if ("entry" in proposal) {
        const entry = entries.find((entry) => entry.id === proposal.entry.id);
        const part = entry?.parts.find((part) => part.part === proposal.entry.part);
        const auditSummary = {
          action: CONNECTION_PROPOSE_TOOL_NAME,
          subject: proposal.entry.id,
          metadata: { type: "entry" }
        };
        if (!entry || !part)
          return {
            status: "failed",
            error: {
              code: "validation_failed",
              message: "This instance does not offer that catalogue entry and part"
            },
            auditSummary
          };
        const existing = part.connection;
        const name = existing?.name ?? part.name;
        return toolSuccess<Proposal>(
          {
            entry: proposal.entry,
            state: existing?.clientSecretSet ? "ready" : "needs_setup",
            mayWrite: await mayWrite(name),
            ...(existing?.credentialMode === "user"
              ? { bindingState: existing.bindingState ?? "not_connected" }
              : {}),
            connection: {
              connectorType: part.connectorType,
              name,
              title: entry.title,
              credentialMode: existing?.credentialMode ?? part.defaultCredentialMode,
              headerNames: []
            }
          },
          { auditSummary }
        );
      }
      const checked = checkProposal(input.connectorTypes, context.user.id, proposal, entries);
      // The id and the type only: the address is no part of an audit record.
      const auditSummary = {
        action: CONNECTION_PROPOSE_TOOL_NAME,
        subject: proposal.connection,
        metadata: { connectorType: proposal.connectorType }
      };
      if (!checked.ok) {
        const details: JsonObject = { issues: checked.issues.map((issue) => ({ ...issue })) };
        return {
          status: "failed",
          error: {
            code: "validation_failed",
            message: `The proposal is refused, so no card shows. Fix each issue and call ${CONNECTION_PROPOSE_TOOL_NAME} again: ${checked.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join("; ")}`,
            details
          },
          auditSummary
        };
      }
      return toolSuccess<Proposal>(
        {
          ...checked.proposal,
          state: "needs_setup",
          mayWrite: await mayWrite(checked.proposal.connection.name)
        },
        { auditSummary }
      );
    }
  });
}
