import {
  DATA_STORE_DESCRIPTION_TOOL_NAME,
  dataStoreDescriptionInputSchema,
  dataStoreDescriptionSchema
} from "@work-shape/catalyst-core";
import { defineTool, toolFailed } from "@work-shape/catalyst-tool-sdk";

/** The metadata operation is implemented by the Data Stores module for every caller. */
export function createDataStoreDescriptionTool() {
  return defineTool({
    name: DATA_STORE_DESCRIPTION_TOOL_NAME,
    title: { en: "Describe Data Store", de: "Datenspeicher beschreiben" },
    group: "platform",
    icon: "guide",
    effect: "reading",
    description:
      "Describe a Data Store without reading rows: its fields in words, row estimates, what fills and reads it, the person's rights and whether this chat has row tools. Find its name with platform.assets.list first. Never infer row contents from metadata. If row tools are missing, report the returned next step: data_store.use is coming, not available yet. Never invent an interface path.",
    inputSchema: dataStoreDescriptionInputSchema,
    outputSchema: dataStoreDescriptionSchema,
    execute: () => toolFailed("handler_failed", "Describe Data Stores through the operation runner")
  });
}
