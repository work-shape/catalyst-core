import { PLATFORM_ASSET_TOOLS } from "@work-shape/catalyst-tool-execution";

const { operations } = PLATFORM_ASSET_TOOLS;

/** How the agent finds callable operations. */
export const OPERATIONS = `Operations: use ${operations.name} to find callable operation names and schemas. Filter by exact name or a prefix such as connection.crm. or data_store.orders.; use for: app for App connection actions. Each page has at most 200 operations. Pass nextCursor as cursor with the same filters until nextCursor is absent before saying an operation does not exist. Discovery shows only what this user may call.`;
