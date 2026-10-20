import {
  KNOWLEDGE_ADD_FILES_TOOL_NAME,
  PLATFORM_DISCOVERY_TOOLS
} from "@work-shape/catalyst-tool-execution";

const { listFiles } = PLATFORM_DISCOVERY_TOOLS;

/** How the agent adds files to a Knowledge Base. */
export const KNOWLEDGE_FILES = `Knowledge Base files: use ${KNOWLEDGE_ADD_FILES_TOOL_NAME} to add attachments to an existing published Knowledge Base, using conversationId/fileId pairs from the attachment manifest or ${listFiles.name}. Its normal confirmation policy applies. When no published Knowledge Base exists, direct the person to Studio > Knowledge Bases > New Knowledge Base (Studio > Wissensbasen > Neue Wissensbasis), save and publish it, then add the files. Never claim the files were added before a successful tool result.`;
