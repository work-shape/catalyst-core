import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  CONNECTION_NAME_MAX_LENGTH,
  findConnectorTypeIssues,
  type AssetValidationIssue,
  type ConnectorTypeRegistry,
  type JsonObject
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { z } from "zod";
import { CONNECTION_DRAFT_TOOL_NAME } from "./connection-draft-tool";
import { CONNECTION_OFFER_TOOL_NAME } from "./connection-offer-tool";

// The agent's proposal of a new Connection (CHAT-CONN-1): the type, the id, the name in words
// and the address, as a card in the conversation. The tab that sent the message the run answers
// opens the New connection dialog with it, the conversation docked beside it, and the card opens
// the dialog again. The person enters the key or signs in there, presses Connect and approves the
// tools; that is the save. The tool reads nothing of the instance, reaches no host and holds no
// key: the proposal has no field for one, and an address that could carry one is refused.

export const CONNECTION_PROPOSE_TOOL_NAME = "platform.connections.propose";

/** The types the New connection dialog takes an address and a key for. */
const MCP = "mcp";
const HTTP_API = "http_api";

/** How many fixed headers a proposal names: the type's own bound. */
const PROPOSAL_HEADERS_MAX = 16;

/** A header name as HTTP spells it. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;

const inputSchema = z.object({
  connectorType: z
    .string()
    .min(1)
    .describe(
      "What to connect: 'mcp' for a remote MCP server, 'http_api' for a REST API, or another Connector type of this instance, which has a form of its own."
    ),
  connection: z
    .string()
    .min(1)
    .max(CONNECTION_NAME_MAX_LENGTH)
    .describe("The new Connection's id in lowercase letters, digits and hyphens, such as 'brain'."),
  title: z.string().min(1).max(120).describe("Its name in words, such as 'Brain'."),
  url: z
    .string()
    .min(1)
    .optional()
    .describe(
      "For 'mcp' the server's address, for 'http_api' the address every request starts with. https, without user name, password, query or fragment. Leave it out for another type: its form asks."
    ),
  keyHeader: z
    .string()
    .optional()
    .describe(
      "For 'mcp' or 'http_api': the name of the header the key is sent in, such as 'x-api-key', where the service does not take it as a bearer token. A name only: the person types the key."
    ),
  headerNames: z
    .array(z.string())
    .max(PROPOSAL_HEADERS_MAX)
    .optional()
    .describe(
      "For 'http_api': names of fixed headers that carry no credential, such as 'x-tenant-id'. The person types their values."
    ),
  testPath: z
    .string()
    .min(1)
    .optional()
    .describe(
      "For 'http_api': a GET path relative to url that answers 2xx only with a valid key, such as '/me'."
    )
});

const outputSchema = z.object({
  connection: z.object({
    connectorType: z.string(),
    name: z.string(),
    title: z.string(),
    url: z.string().optional(),
    keyHeader: z.string().optional(),
    headerNames: z.array(z.string()),
    testPath: z.string().optional()
  })
});

type ProposalInput = z.infer<typeof inputSchema>;
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
function addressIssues(url: string): ProposalIssue[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ path: "url", message: "The address is no URL" }];
  }
  const issues: ProposalIssue[] = [];
  if (parsed.protocol !== "https:") {
    issues.push({ path: "url", message: "The address starts with https://" });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    issues.push({
      path: "url",
      message: "The address carries no user name or password: the person enters the key",
      code: "credential_in_url"
    });
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    issues.push({
      path: "url",
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
  input: ProposalInput
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
    for (const field of ["url", "keyHeader", "headerNames", "testPath"] as const) {
      if (input[field] !== undefined) {
        issues.push({
          path: field,
          message: `A '${input.connectorType}' form asks for this itself`
        });
      }
    }
  }
  if (input.connectorType !== HTTP_API) {
    for (const field of ["headerNames", "testPath"] as const) {
      if (takesAddress && input[field] !== undefined) {
        issues.push({ path: field, message: "Only a REST API ('http_api') takes this" });
      }
    }
  }
  if (input.keyHeader !== undefined && !HEADER_NAME.test(input.keyHeader)) {
    issues.push({ path: "keyHeader", message: "The header name is no HTTP header name" });
  }
  if (input.url !== undefined && takesAddress) issues.push(...addressIssues(input.url));
  const candidate = {
    name: input.connection,
    displayName: input.title,
    connectorType: input.connectorType,
    ownerPrincipalId,
    settings: takesAddress && input.url !== undefined ? addressSettings(input, input.url) : {},
    authScheme: input.keyHeader === undefined ? "none" : "header",
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
      connection: {
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
      "Propose a new Connection when the person wants data from an outside system that no Connection of the instance reaches yet: a remote MCP server ('mcp'), a REST API ('http_api') or another Connector type of the instance.",
      "Name the type, an id, a name in words and, for 'mcp' or 'http_api', the address. The tool checks them and answers the proposal, which shows as a card; the person's screen then opens the New connection dialog filled with it, with this conversation beside it. Nothing is saved before the person presses Connect there.",
      "Never ask for a key, token or password, and never put one into the proposal or the address: the person enters the key, or signs in, in the dialog. Say in one sentence that they enter the key or sign in there and press Connect.",
      "When they have connected, a message from them says so and which tools they approved. Then go on: for a REST API draft its tools with " +
        CONNECTION_DRAFT_TOOL_NAME +
        "; offer approved tools to an agent with " +
        CONNECTION_OFFER_TOOL_NAME +
        " where you hold it; then build what they asked for.",
      "An issue in the answer is fixed before you call the tool again; no card shows until the proposal passes."
    ].join(" "),
    inputSchema,
    outputSchema,
    execute(proposal, context) {
      const checked = checkProposal(input.connectorTypes, context.user.id, proposal);
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
          auditSummary: { ...auditSummary, metadata: { ...auditSummary.metadata, refused: true } }
        };
      }
      return toolSuccess(checked.proposal, { auditSummary });
    }
  });
}
