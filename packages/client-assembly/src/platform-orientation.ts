import { SCHEDULED_START_TOOL_NAMES } from "@work-shape/catalyst-tool-execution";
import { CATALYST_INTERNAL_AGENT_PROMPT } from "@work-shape/catalyst-agent-runtime";
import { RUN_AGENT_TOOL_NAME } from "@work-shape/catalyst-core";
import type { PlatformInstructions } from "@work-shape/catalyst-server";
import {
  KNOWLEDGE_ADD_FILES_TOOL_NAME,
  CONNECTION_DRAFT_TOOL_NAME,
  CONNECTION_OFFER_TOOL_NAME,
  CONNECTION_PROPOSE_TOOL_NAME,
  APP_PUBLISH_TOOL_NAME,
  APP_TRY_TOOL_NAMES,
  PLATFORM_ASSET_TOOL_NAMES,
  PLATFORM_DISCOVERY_TOOL_NAMES,
  WORKFLOW_TEST_TOOL_NAMES
} from "@work-shape/catalyst-tool-execution";
import { CHANGING } from "./orientation/changing";
import { DATA_STORE_ROWS } from "./orientation/data-store-rows";
import { DOCS } from "./orientation/docs";
import { EVIDENCE } from "./orientation/evidence";
import { FINDING } from "./orientation/finding";
import { ASSET_KINDS } from "./orientation/kinds";
import { KINDS_HERE } from "./orientation/kinds-here";
import { KNOWLEDGE_FILES } from "./orientation/knowledge-files";
import { LOCATION } from "./orientation/location";
import { NAMING } from "./orientation/naming";
import { OPERATIONS } from "./orientation/operations";
import { ORIENTATION_QUESTIONS } from "./orientation/orientation-questions";
import { RIGHTS_REFUSALS } from "./orientation/rights-refusals";
import { SHOWN_BESIDE_CHAT } from "./orientation/shown";
import { WORDS } from "./orientation/words";

// How the platform works, for an agent that holds the platform's tools: a section of its system
// prompt, sent with every message, so it stays short. The details are in the skill
// `platform-docs`. What exists on one instance and what the person may do there, the agent asks
// the tools: this text names no module that is on and no right that is held. Each paragraph is
// a file of its own under `orientation/`, joined below in the order the agent reads them.

export const PLATFORM_ORIENTATION = [
  ASSET_KINDS,
  SHOWN_BESIDE_CHAT,
  KINDS_HERE,
  FINDING,
  OPERATIONS,
  CHANGING,
  EVIDENCE,
  WORDS,
  KNOWLEDGE_FILES,
  DATA_STORE_ROWS,
  LOCATION,
  RIGHTS_REFUSALS,
  ORIENTATION_QUESTIONS,
  NAMING,
  DOCS
].join("\n");

/**
 * The platform's tools: those that find, open, read and save an asset. An agent whose own
 * definition lists one of them holds them.
 */
export const PLATFORM_TOOL_NAMES: readonly string[] = [
  ...SCHEDULED_START_TOOL_NAMES,
  ...PLATFORM_DISCOVERY_TOOL_NAMES,
  ...PLATFORM_ASSET_TOOL_NAMES
];

/**
 * Platform tools that turn off with their module. Connection drafts are explicitly assigned;
 * Workflow testing and result reads are also offered to agents that hold platform tools.
 * No release needs to enable them individually.
 */
export const PLATFORM_MODULE_TOOL_NAMES: readonly string[] = [
  CONNECTION_PROPOSE_TOOL_NAME,
  CONNECTION_DRAFT_TOOL_NAME,
  CONNECTION_OFFER_TOOL_NAME,
  KNOWLEDGE_ADD_FILES_TOOL_NAME,
  APP_PUBLISH_TOOL_NAME,
  ...APP_TRY_TOOL_NAMES,
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
