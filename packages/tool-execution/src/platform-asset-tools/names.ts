import { SUBJECT_TOOL_PREFIX } from "@work-shape/catalyst-core";

/** One row per tool: its name for the agent, and the operation of the API it projects. */
export const PLATFORM_ASSET_TOOLS = {
  open: { name: `${SUBJECT_TOOL_PREFIX}open`, operation: "assets.get", effect: "reading" },
  get: { name: `${SUBJECT_TOOL_PREFIX}get`, operation: "assets.get", effect: "reading" },
  validate: {
    name: `${SUBJECT_TOOL_PREFIX}validate`,
    operation: "assets.validate",
    effect: "reading"
  },
  put: { name: `${SUBJECT_TOOL_PREFIX}put`, operation: "assets.put", effect: "changing" },
  operations: {
    name: `${SUBJECT_TOOL_PREFIX}operations`,
    operation: "operations.list_callable",
    effect: "reading"
  }
} as const;

/** The names of the tools that open, read and save an asset. */
export const PLATFORM_ASSET_TOOL_NAMES: readonly string[] = Object.values(PLATFORM_ASSET_TOOLS).map(
  (tool) => tool.name
);
