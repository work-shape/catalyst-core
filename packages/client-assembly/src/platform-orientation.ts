import { CATALYST_INTERNAL_AGENT_PROMPT } from "@work-shape/catalyst-agent-runtime";
import { RUN_AGENT_TOOL_NAME } from "@work-shape/catalyst-core";
import type { PlatformInstructions } from "@work-shape/catalyst-server";
import {
  CONNECTION_DRAFT_TOOL_NAME,
  APP_SAVE_TOOL_NAME,
  PLATFORM_ASSET_TOOLS,
  PLATFORM_ASSET_TOOL_NAMES,
  PLATFORM_DISCOVERY_TOOLS,
  PLATFORM_DISCOVERY_TOOL_NAMES,
  WORKSPACE_OPEN_TOOL_NAME,
  WORKFLOW_TEST_TOOL_NAMES
} from "@work-shape/catalyst-tool-execution";
import { PLATFORM_DOCS_SKILL_NAME } from "./platform-docs-skill";

// How the platform works, for an agent that holds the platform's tools: a section of its system
// prompt, sent with every message, so it stays short. The details are in the skill
// `platform-docs`. What exists on one instance and what the person may do there, the agent asks
// the tools: this text names no module that is on and no right that is held.

const { context, listAssets, listFiles } = PLATFORM_DISCOVERY_TOOLS;
const { open, get, validate, put } = PLATFORM_ASSET_TOOLS;

export const PLATFORM_ORIENTATION = `You run on a platform where people build and use agents, Workflows and Apps. What it keeps are assets, each with a kind, a unique lowercase name and a title:
- agent: an assistant with instructions, a model, tools and skills. You are one.
- skill: instructions an agent reads when a task matches.
- workflow: steps that run one after the other, by hand or on a schedule, without a person in the chat.
- app: a folder you opened and saved as an App, with data that is kept and actions on Connections and Data Stores.
- data_store: tables of structured data that Apps and Workflows read and write.
- knowledge_base: documents, indexed so agents can search them.
- connection: access to an outside system and the operations it offers: a remote MCP server, or a REST API whose read operations a person approves; where you hold ${CONNECTION_DRAFT_TOOL_NAME}, you draft them with it. You never save a Connection. A person enters its key on the Connection's page in Studio, never in this chat: never ask for a key, token or password.
What you show beside the chat is no asset: write its files and show an HTML file or an App's folder with ${WORKSPACE_OPEN_TOOL_NAME}. A quick view with data you write in needs nothing more; data that is kept, records people change or something to use again is an App: when the user says "save this as an app", call ${APP_SAVE_TOOL_NAME} on what you opened and never build it again. Saving asks the user nothing and gives them the App at once; sharing it with others is their step. Before you write an App's actions, read references/apps/build.md of '${PLATFORM_DOCS_SKILL_NAME}'. Something that should run again without the user is a Workflow.
Not every instance has every kind: ${context.name} says which kinds and modules exist here and what the user may do.
Finding: call ${listAssets.name} before you say something does not exist. It answers names, titles and descriptions, never contents. What the user may not see is not listed: then say you know nothing of that name. ${listFiles.name} finds previews and files of other conversations of this workspace.
Changing: you change drafts only. A draft runs nowhere until a person publishes it. You never publish, never start a run that changes data and never grant a right. Call ${open.name} before you change an asset or when the user asks to see it; ${get.name} only reads. Check with ${validate.name} and save the draft with ${put.name}; only the asset opened last is saved. To build a new Workflow, Data Store, agent or skill, call ${put.name} with its kind and name and no expected revision, in a conversation where nothing is open yet: that first save creates it and opens it. A Workflow or Data Store starts as a draft; a Data Store is saved as files, its store.yaml and its first migration. An agent you create is offered nowhere until a person places it. An agent you cannot save: say what you would change, and the user changes it in Studio. In a conversation shared with a workspace no asset opens: ask the user to start one of their own.
For how the product works in detail, read the skill '${PLATFORM_DOCS_SKILL_NAME}'.`;

/**
 * The platform's tools: those that find, open, read and save an asset. An agent whose own
 * definition lists one of them holds them.
 */
export const PLATFORM_TOOL_NAMES: readonly string[] = [
  ...PLATFORM_DISCOVERY_TOOL_NAMES,
  ...PLATFORM_ASSET_TOOL_NAMES
];

/**
 * Platform tools that turn off with their module. Connection drafts are explicitly assigned;
 * Workflow testing and result reads are also offered to agents that hold platform tools.
 * No release needs to enable them individually.
 */
export const PLATFORM_MODULE_TOOL_NAMES: readonly string[] = [
  CONNECTION_DRAFT_TOOL_NAME,
  ...WORKFLOW_TEST_TOOL_NAMES
];

/** What the platform tells its agents before their own instructions, as an agent page shows it. */
export const PLATFORM_INSTRUCTIONS: PlatformInstructions = {
  rules: CATALYST_INTERNAL_AGENT_PROMPT,
  orientation: PLATFORM_ORIENTATION,
  toolNames: PLATFORM_TOOL_NAMES
};

/**
 * The tools an agent of an instance may list: those the release enables and the platform's own,
 * which no release names and which an agent holds only where its definition lists them.
 */
export function agentListableToolNames(enabledByRelease: Iterable<string>): string[] {
  return [
    ...new Set([
      ...enabledByRelease,
      ...PLATFORM_TOOL_NAMES,
      ...PLATFORM_MODULE_TOOL_NAMES,
      RUN_AGENT_TOOL_NAME
    ])
  ];
}
