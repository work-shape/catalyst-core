import { z } from "zod";
import {
  DATA_STORE_ACTIONS,
  DATA_STORE_OPERATION_RIGHTS,
  DATA_STORE_OPERATION_VERBS,
  DATA_STORE_USE_TOOL_NAME,
  type ToolExecutionContext
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";

// A Data Store in a conversation for reading (STORE-USE-1): the person's own store is added at
// once and its read tools reach the agent within the same turn; any other store waits for the
// person's click on a card, after which the conversation goes on by itself. Adding a store
// grants nothing: every read still asks the person's `data_store.read`.

/**
 * The verbs a store added to a conversation offers: those that need only the right to read it
 * (`query`, `describe`, `preview_rows`).
 */
export const DATA_STORE_USE_VERBS = DATA_STORE_OPERATION_VERBS.filter(
  (verb) => DATA_STORE_OPERATION_RIGHTS[verb] === DATA_STORE_ACTIONS.read
);

export const dataStoreUsedSchema = z.object({
  name: z.string(),
  title: z.string(),
  /** The store's read tools are in this conversation now. */
  added: z.boolean(),
  /** The store waits for the person's click on the card; nothing was added yet. */
  awaitsPerson: z.literal(true).optional(),
  /** Others read this conversation and would see what the agent answers from the store. */
  othersRead: z.literal(true).optional(),
  /** The tools the store offers here once added, by name. */
  readTools: z.array(z.string())
});

export type DataStoreUsed = z.infer<typeof dataStoreUsedSchema>;

export interface DataStoreUseCalls {
  useDataStore(context: ToolExecutionContext, input: { name: string }): Promise<DataStoreUsed>;
}

export function createDataStoreUseTool(calls: DataStoreUseCalls) {
  return defineTool({
    name: DATA_STORE_USE_TOOL_NAME,
    title: { en: "Use Data Store in this chat", de: "Datenspeicher in diesem Chat nutzen" },
    summary: {
      en: "Adds a Data Store to this conversation for reading, next to what it is about.",
      de: "Fügt einen Datenspeicher zum Lesen zu dieser Unterhaltung hinzu, neben ihrem Thema."
    },
    group: "platform",
    icon: "guide",
    effect: "changing",
    permission: { mode: "allow" },
    description: [
      "When the person asks about the rows of a Data Store and this conversation has no data_store.<store>.query tool for it, add the store here for reading. Find its name with platform.assets.list or platform.data_stores.describe first.",
      "It adds the store's describe, query and preview_rows tools next to what the conversation is about; it never changes the subject and never gives tools that change rows. The person's right to read the store is checked on every call.",
      "With 'added' true the tools are in your tool list for your next step: go on and answer from them.",
      "With 'awaitsPerson' the person sees a card to confirm. Say in one sentence that they can confirm it on the card, and call nothing else; the conversation goes on by itself after their click. With 'othersRead' the card also tells them that others who read this conversation see your answers from the store."
    ].join(" "),
    inputSchema: z.object({
      name: z
        .string()
        .min(1)
        .max(120)
        .describe("The Data Store's name, as platform.assets.list returns it.")
    }),
    outputSchema: dataStoreUsedSchema,
    async execute(input, context) {
      const used = await calls.useDataStore(context, input);
      return toolSuccess(used, {
        auditSummary: {
          action: DATA_STORE_USE_TOOL_NAME,
          metadata: { added: used.added, awaitsPerson: used.awaitsPerson === true }
        }
      });
    }
  });
}
