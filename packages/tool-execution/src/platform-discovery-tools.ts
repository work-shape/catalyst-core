import type { ConnectionProposalCatalogue } from "./connection-propose-tool";
import { z } from "zod";
import {
  FOUND_FILE_KINDS,
  CATALOGUE_PARTS,
  CONNECTION_CREDENTIAL_MODES,
  COLLABORATION_WORKSPACE_KINDS,
  type CollaborationWorkspaceKind,
  type CataloguePart,
  type ConnectionCredentialMode,
  type ConnectorTypeRegistry,
  type FoundFile,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";
import { LINK_THE_PAGE } from "./platform-asset-tools/shapes";

// The tools an agent finds what is on the platform with, in every conversation. Each is a
// projection of an operation of the API, carried out for the person the agent acts for with
// that person's rights: an asset or a file the person may not read is not listed, as if it
// did not exist. All only read.

/** One row per tool: its name for the agent, and the operation of the API it projects. */
export const PLATFORM_DISCOVERY_TOOLS = {
  context: { name: "platform.context", operation: "platform.context.get", effect: "reading" },
  listAssets: { name: "platform.assets.list", operation: "assets.list", effect: "reading" },
  listFiles: { name: "platform.files.list", operation: "workspaces.files.list", effect: "reading" }
} as const;

/** The names of the tools every conversation is offered to find what is on the platform. */
export const PLATFORM_DISCOVERY_TOOL_NAMES: readonly string[] = Object.values(
  PLATFORM_DISCOVERY_TOOLS
).map((tool) => tool.name);

/**
 * How many assets or files one search answers. It has no pages: a longer list asks a narrower
 * search.
 */
export const PLATFORM_ASSET_LIST_MAX = 50;

/** What this instance has and what the person the agent acts for may do on it. */
export interface PlatformContextRead {
  /** One active administrator the person can ask about missing rights. */
  helpContact?: { displayLabel: string };
  /** Published agents and Apps offered in this conversation's workspace, in the caller's language. */
  availableHere?: {
    agents: { name: string; title: string }[];
    apps: { name: string; title: string }[];
    appsTruncated: boolean;
  };
  /** The person the agent acts for; use this id for a request to notify "me". */
  caller?: { id: string; displayLabel: string; email?: string };
  /** Active shared accounts without API keys whose rights the caller may publish. Never invented defaults. */
  workflowPrincipals?: { name: string; displayLabel: string }[];
  /** Name/email matches within the caller's directory rights, or just the caller. */
  people?: { id: string; displayLabel: string; email?: string }[];
  peopleTruncated?: boolean;
  instance: { name: string; timeZone?: string; timeZoneDefaulted?: boolean };
  /** The modules that are on. */
  modules: string[];
  /** The kinds of asset that exist here: those of a module that is off are not among them. */
  kinds: {
    kind: string;
    plural: string;
    hasDraft: boolean;
    /**
     * A create of the kind by this person in this conversation files a request and creates
     * nothing until one of `approverNames` approves it. Left out where it asks for their
     * confirmation, as a create of a skill does by default.
     */
    createApproval?: { approverNames: string[] };
  }[];
  /** The rights the person holds on instance-owned assets of a kind, such as `workflow.write`. */
  actions: string[];
  /** The read rights the person holds on some assets of a kind only. */
  assetActions: string[];
  /** Visible workspaces and the rights the person holds on their assets. */
  workspaces: {
    id: string;
    name: string;
    kind: CollaborationWorkspaceKind;
    member: boolean;
    /** This conversation's workspace; rights on another workspace do not apply here. */
    current?: true;
    actions: string[];
  }[];
  /**
   * The kinds of Connection this instance can make, where the module `connections` is on, and
   * how each signs in to the outside system. An agent reads it before it plans to connect a
   * system, instead of researching what the platform answers.
   */
  connectorTypes?: PlatformConnectorTypeRead[];
  catalogue?: {
    entries: {
      id: string;
      title: string;
      category: string;
      parts: {
        part: CataloguePart;
        credentialModes: ConnectionCredentialMode[];
        defaultCredentialMode: ConnectionCredentialMode;
        connection?: { name: string; clientSecretSet: boolean };
      }[];
    }[];
  };
}

/** One kind of Connection this instance can make. */
export interface PlatformConnectorTypeRead {
  /** The id a Connection names as its `connectorType`, such as `mcp` or `http_api`. */
  type: string;
  description: string;
  /**
   * How a Connection of the type signs in: `none`, `bearer` or `header` (a key the person
   * enters), `oauth` (the person signs in with the provider).
   */
  signIn: string[];
  /** The system a ready-made type connects to, such as `gmail`. Absent for a generic type. */
  service?: string;
}

/** One asset a search found: what it is called and what it is for, never what it holds. */
export interface PlatformAssetFound {
  kind: string;
  name: string;
  title: string;
  description?: string;
  /** The path of the page where the person works on it, where its kind has one. */
  href?: string;
}

/** One Page or file a search found, and the conversation it lives in. */
export type PlatformFileFound = FoundFile & {
  /** Set on what lives in the conversation the agent runs in, the one it can open. */
  inThisConversation?: true;
};

/** What carries the tools out, for the person of `context`. */
export interface PlatformDiscoveryCalls {
  readContext(
    context: ToolExecutionContext,
    input?: { person?: string }
  ): Promise<PlatformContextRead>;
  /**
   * The assets the person may read, of one kind or of every kind that exists here, whose name
   * contains `text`, owned by the instance or by the workspace of the conversation. At most
   * `PLATFORM_ASSET_LIST_MAX`; `truncated` says there are more. A kind that does not exist
   * here is refused.
   */
  listAssets(
    context: ToolExecutionContext,
    input: { kind?: string; text?: string }
  ): Promise<{ assets: PlatformAssetFound[]; truncated: boolean }>;
  /**
   * The Pages and files of the conversations of the workspace of the conversation that the
   * person may read, newest first, whose name or conversation title contains `text`. At most
   * `PLATFORM_ASSET_LIST_MAX`; `truncated` says there are more.
   */
  listFiles(
    context: ToolExecutionContext,
    input: { kind?: FoundFile["kind"]; text?: string }
  ): Promise<{ files: PlatformFileFound[]; truncated: boolean }>;
}

/** Text a search names. Postgres stores no NUL, so one is refused before it reaches the store. */
const searchText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\u0000]*$/u, "must not contain a NUL character");

const catalogueContextSchema = z.object({
  entries: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      category: z.string(),
      parts: z.array(
        z.object({
          part: z.enum(CATALOGUE_PARTS),
          credentialModes: z.array(z.enum(CONNECTION_CREDENTIAL_MODES)),
          defaultCredentialMode: z.enum(CONNECTION_CREDENTIAL_MODES),
          connection: z.object({ name: z.string(), clientSecretSet: z.boolean() }).optional()
        })
      )
    })
  )
});

const contextOutputSchema = z.object({
  catalogue: catalogueContextSchema.optional(),
  helpContact: z.object({ displayLabel: z.string() }).optional(),
  availableHere: z
    .object({
      agents: z.array(z.object({ name: z.string(), title: z.string() })),
      apps: z.array(z.object({ name: z.string(), title: z.string() })),
      appsTruncated: z.boolean()
    })
    .optional(),
  caller: z
    .object({ id: z.string(), displayLabel: z.string(), email: z.string().optional() })
    .optional(),
  workflowPrincipals: z.array(z.object({ name: z.string(), displayLabel: z.string() })).optional(),
  people: z
    .array(z.object({ id: z.string(), displayLabel: z.string(), email: z.string().optional() }))
    .optional(),
  peopleTruncated: z.boolean().optional(),
  instance: z.object({
    name: z.string(),
    timeZone: z.string().optional(),
    timeZoneDefaulted: z.boolean().optional()
  }),
  modules: z.array(z.string()),
  kinds: z.array(
    z.object({
      kind: z.string(),
      plural: z.string(),
      hasDraft: z.boolean(),
      createApproval: z.object({ approverNames: z.array(z.string()) }).optional()
    })
  ),
  actions: z.array(z.string()),
  assetActions: z.array(z.string()),
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(COLLABORATION_WORKSPACE_KINDS),
      member: z.boolean(),
      current: z.literal(true).optional(),
      actions: z.array(z.string())
    })
  ),
  connectorTypes: z
    .array(
      z.object({
        type: z.string(),
        description: z.string(),
        signIn: z.array(z.string()),
        service: z.string().optional()
      })
    )
    .optional()
});

/** The Connector types of the build as an agent reads them. */
function connectorTypesRead(registry: ConnectorTypeRegistry): PlatformConnectorTypeRead[] {
  return registry.types.map((definition) => ({
    type: definition.type,
    description: definition.description,
    signIn: [...definition.authSchemes],
    ...(definition.form?.service ? { service: definition.form.service } : {})
  }));
}

const listAssetsOutputSchema = z.object({
  assets: z.array(
    z.object({
      kind: z.string(),
      name: z.string(),
      title: z.string(),
      description: z.string().optional(),
      href: z.string().optional()
    })
  ),
  truncated: z.boolean()
});

const listFilesOutputSchema = z.object({
  files: z.array(
    z.object({
      kind: z.enum(FOUND_FILE_KINDS),
      id: z.string(),
      name: z.string(),
      mimeType: z.string().optional(),
      bytes: z.number(),
      updatedAt: z.string(),
      conversation: z.object({ id: z.string(), title: z.string() }),
      inThisConversation: z.literal(true).optional()
    })
  ),
  truncated: z.boolean()
});

export function createPlatformDiscoveryTools(
  calls: PlatformDiscoveryCalls,
  options: {
    /** The Connector types of the instance, where the module `connections` is on. */
    connectorTypes?: ConnectorTypeRegistry | undefined;
    catalogue?: ConnectionProposalCatalogue | undefined;
  } = {}
): AnyToolDefinition[] {
  const { context, listAssets, listFiles } = PLATFORM_DISCOVERY_TOOLS;
  return [
    defineTool({
      name: context.name,
      title: { en: "Read platform context", de: "Plattform-Kontext lesen" },
      summary: {
        en: "Reads which modules are on and what the user may do on this instance.",
        de: "Liest, welche Module an sind und was die Person auf dieser Instanz darf."
      },
      group: "platform",
      icon: "guide",
      effect: context.effect,
      description: [
        "Read what this instance offers and what the user may do on it: the modules that are on, the kinds of asset as far as they are on, and the user's rights. Call it before you say whether something can be built here or whether the user may change it.",
        "'actions' are rights on instance-owned assets of a kind, such as 'workflow.write' (save drafts) or 'workflow.publish'; 'assetActions' are read rights on some assets of a kind. 'workspaces' names visible workspaces and the rights on their assets; current: true marks this conversation's. Before refusing a create or change, check the actions of the workspace that owns it. A workspace skill.write allows creating a skill there even when actions has no skill.write; rights on another workspace do not apply here. A kind's createApproval names who approves a create. availableHere lists the published agents and Apps offered here.",
        "catalogue.entries lists the services the instance offers. connectorTypes lists the kinds of Connection this instance can make and how each signs in: none, bearer or header (a key the person enters), oauth (the person signs in with the provider) or oauth_client (the instance signs in as an app registered with the provider). Read them before you plan to connect a system, instead of the provider's documentation.",
        "Leave runAs out of a new Workflow; publishing creates its own account. Use a name from workflowPrincipals only when the person asks for an existing shared account, never integration or release accounts. Schedules use instance.timeZone (UTC where timeZoneDefaulted: say so); store the intended IANA timeZone on each trigger and never shift the wall clock into UTC. caller is the person you act for: use caller.id to notify 'me'. 'person' resolves a recipient by name or email: with no match ask for a clearer name, with several ask which one, never for an internal id."
      ].join(" "),
      inputSchema: z.object({
        person: searchText(200)
          .optional()
          .describe("Part of a notification recipient's name or email. Never an internal id.")
      }),
      outputSchema: contextOutputSchema,
      async execute(input, toolContext) {
        const read: PlatformContextRead = {
          ...(await calls.readContext(toolContext, input)),
          ...(options.catalogue
            ? {
                catalogue: {
                  entries: (await options.catalogue.read(toolContext)).map((entry) => ({
                    id: entry.id,
                    title: entry.title,
                    category: entry.category,
                    parts: entry.parts.map((part) => ({
                      part: part.part,
                      credentialModes: part.credentialModes,
                      defaultCredentialMode: part.defaultCredentialMode,
                      ...(part.connection
                        ? {
                            connection: {
                              name: part.connection.name,
                              clientSecretSet: part.connection.clientSecretSet
                            }
                          }
                        : {})
                    }))
                  }))
                }
              }
            : {}),
          ...(options.connectorTypes
            ? { connectorTypes: connectorTypesRead(options.connectorTypes) }
            : {})
        };
        return toolSuccess(read, {
          auditSummary: {
            action: context.name,
            metadata: { kindCount: read.kinds.length, actionCount: read.actions.length }
          }
        });
      }
    }),
    defineTool({
      name: listAssets.name,
      title: { en: "Find assets", de: "Assets finden" },
      summary: {
        en: "Finds the agents, skills, Workflows, Apps and other assets the user may see.",
        de: "Findet die Agenten, Skills, Workflows, Apps und anderen Assets, die die Person sehen darf."
      },
      group: "platform",
      icon: "guide",
      effect: listAssets.effect,
      description: [
        "Find the assets the user may see: agents, skills, Workflows, Apps, Data Stores, Knowledge Bases and Connections, with kind, name, title and description, never their content. What the user may not see is not listed: say you know none of that name.",
        `At most ${PLATFORM_ASSET_LIST_MAX}; 'truncated' says there are more, so search narrower. Pages and files are no assets: ${listFiles.name} finds them.`,
        LINK_THE_PAGE
      ].join(" "),
      inputSchema: z.object({
        kind: searchText(100)
          .optional()
          .describe("One kind as platform.context lists it, such as 'workflow'."),
        text: searchText(200).optional().describe("Part of the name or the title.")
      }),
      outputSchema: listAssetsOutputSchema,
      async execute(input, toolContext) {
        const found = await calls.listAssets(toolContext, input);
        return toolSuccess(found, {
          auditSummary: {
            action: listAssets.name,
            metadata: {
              ...(input.kind === undefined ? {} : { kind: input.kind }),
              assetCount: found.assets.length,
              truncated: found.truncated
            }
          }
        });
      }
    }),
    defineTool({
      name: listFiles.name,
      title: { en: "Find previews and files", de: "Vorschauen und Dateien finden" },
      summary: {
        en: "Finds the previews and files in this workspace's conversations that the user may see.",
        de: "Findet die Vorschauen und Dateien in den Unterhaltungen dieses Arbeitsbereichs, die die Person sehen darf."
      },
      group: "platform",
      icon: "files",
      effect: listFiles.effect,
      description: [
        "Find the previews and files in this workspace's conversations that the user may see: folders shown with workspace.open ('page'), uploads ('upload') and files an agent made ('generated_file'), newest first, with name, type, size, change time and conversation, never their content. What the user may not see is not listed: say you know none of that name.",
        `At most ${PLATFORM_ASSET_LIST_MAX}; 'truncated' says there are more, so search narrower. Only what is marked 'inThisConversation' can be read here; for anything else, tell the user which conversation holds it.`
      ].join(" "),
      inputSchema: z.object({
        kind: z.enum(FOUND_FILE_KINDS).optional().describe("Only previews, uploads or made files."),
        text: searchText(200)
          .optional()
          .describe("Part of the name or of the conversation's title.")
      }),
      outputSchema: listFilesOutputSchema,
      async execute(input, toolContext) {
        const found = await calls.listFiles(toolContext, input);
        return toolSuccess(found, {
          auditSummary: {
            action: listFiles.name,
            metadata: {
              ...(input.kind === undefined ? {} : { kind: input.kind }),
              fileCount: found.files.length,
              truncated: found.truncated
            }
          }
        });
      }
    })
  ];
}
