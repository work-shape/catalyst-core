import { z } from "zod";
import {
  FOUND_FILE_KINDS,
  type FoundFile,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess, type AnyToolDefinition } from "@work-shape/catalyst-tool-sdk";

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
  instance: { name: string };
  /** The modules that are on. */
  modules: string[];
  /** The kinds of asset that exist here: those of a module that is off are not among them. */
  kinds: { kind: string; plural: string; hasDraft: boolean }[];
  /** The rights the person holds on every asset of a kind, such as `workflow.write`. */
  actions: string[];
  /** The read rights the person holds on some assets of a kind only. */
  assetActions: string[];
  /** The Namespaces the person holds a right in, with those rights. */
  namespaces: { prefix: string; displayName: string; actions: string[] }[];
}

/** One asset a search found: what it is called and what it is for, never what it holds. */
export interface PlatformAssetFound {
  kind: string;
  name: string;
  title: string;
  description?: string;
}

/** One Page or file a search found, and the conversation it lives in. */
export type PlatformFileFound = FoundFile & {
  /** Set on what lives in the conversation the agent runs in, the one it can open. */
  inThisConversation?: true;
};

/** What carries the tools out, for the person of `context`. */
export interface PlatformDiscoveryCalls {
  readContext(context: ToolExecutionContext): Promise<PlatformContextRead>;
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

const contextOutputSchema = z.object({
  instance: z.object({ name: z.string() }),
  modules: z.array(z.string()),
  kinds: z.array(z.object({ kind: z.string(), plural: z.string(), hasDraft: z.boolean() })),
  actions: z.array(z.string()),
  assetActions: z.array(z.string()),
  namespaces: z.array(
    z.object({ prefix: z.string(), displayName: z.string(), actions: z.array(z.string()) })
  )
});

const listAssetsOutputSchema = z.object({
  assets: z.array(
    z.object({
      kind: z.string(),
      name: z.string(),
      title: z.string(),
      description: z.string().optional()
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

export function createPlatformDiscoveryTools(calls: PlatformDiscoveryCalls): AnyToolDefinition[] {
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
        "Read what this instance can do and what the user may do on it: the modules that are on, the kinds of asset that exist (agent, skill, workflow, app, data_store, knowledge_base, connection, as far as they are on), and the user's rights.",
        "'actions' are rights on every asset of a kind, such as 'workflow.read', 'workflow.write' (save drafts) or 'workflow.publish'. 'assetActions' are read rights on some assets of a kind only. 'namespaces' are rights on the assets whose names start with a prefix.",
        "Call it before you say whether something can be built here or whether the user may change it."
      ].join(" "),
      inputSchema: z.object({}),
      outputSchema: contextOutputSchema,
      async execute(_input, toolContext) {
        const read = await calls.readContext(toolContext);
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
        "Find the assets the user may see on this platform: agents, skills, Workflows, Apps, Data Stores, Knowledge Bases and Connections.",
        "Answers the kind, the name, the title and the description of each, never what it holds. An asset the user may not see is not listed; say that you know none of that name, not that it is hidden.",
        `Give 'kind' to search one kind, and 'text' for part of the name or the title. Answers at most ${PLATFORM_ASSET_LIST_MAX}; 'truncated' says there are more, so search narrower.`,
        `Pages and files are not assets: ${listFiles.name} finds them.`
      ].join(" "),
      inputSchema: z.object({
        kind: searchText(100)
          .optional()
          .describe(
            "One kind as platform.context lists it, such as 'workflow' or 'app'. Without it every kind is searched."
          ),
        text: searchText(200)
          .optional()
          .describe(
            "Part of the name or the title, whatever the case. Names use lowercase and hyphens."
          )
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
        "Find the previews and files in the conversations of this workspace that the user may see: folders shown with workspace.open ('page'), files people uploaded ('upload') and files an agent made in a workspace ('generated_file'). Newest first.",
        "Answers the name, the type, the size, when it last changed and the conversation it lives in, never what it holds. What the user may not see is not listed; say that you know none of that name, not that it is hidden.",
        `Give 'text' for part of the name or of the title of its conversation, and 'kind' for one kind. Answers at most ${PLATFORM_ASSET_LIST_MAX}; 'truncated' says there are more, so search narrower.`,
        "You can read only what is marked 'inThisConversation', with the tools you read files with. For anything else, tell the user which conversation holds it, so they can open it there or add the file to this one."
      ].join(" "),
      inputSchema: z.object({
        kind: z.enum(FOUND_FILE_KINDS).optional().describe("Only previews, uploads or made files."),
        text: searchText(200)
          .optional()
          .describe("Part of the name or of the conversation's title, whatever the case.")
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
