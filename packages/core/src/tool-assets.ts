import type { AssetKindActions } from "./asset-kinds";

export {
  TOOL_ASSET_KIND,
  TOOL_DESCRIPTION_MAX_CHARS,
  TOOL_INPUT_SCHEMA_MAX_BYTES,
  TOOL_NAME_MAX_LENGTH,
  TOOL_NAME_PATTERN,
  TOOL_NAME_RULE,
  TOOL_OPERATION_PREFIX,
  TOOL_RESULT_DEFAULT_REPLY,
  TOOL_TYPES,
  toolAssetConfigSchema,
  toolCallOperationName,
  toolNameSchema,
  toolOfOperationName,
  type ToolAssetConfig
} from "@work-shape/catalyst-asset-schemas";

/**
 * The rights of the kind `tool` (TOOL-1). Calling a published tool asks none of them: a tool
 * writes only into the caller's own conversation. Spec: platform-access.md, section 3a.
 */
export const TOOL_ACTIONS = {
  read: "tool.read",
  write: "tool.write",
  publish: "tool.publish",
  approve: "tool.approve",
  delete: "tool.delete"
} as const satisfies AssetKindActions;
