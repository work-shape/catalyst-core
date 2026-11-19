import type { z } from "zod";
import type { JsonObject, JsonValue, OperationEffect } from "@work-shape/catalyst-core";
import { deriveInputJsonSchema } from "./input-json-schema";

// A code tool written in TypeScript (TOOL-2d, platform-access.md, section 3a): the shape release
// tools use, with the sandbox's context in place of the host's. A tool folder's `index.ts`
// exports it; `catalyst tool put <folder>` reads its name, description and input schema and
// bundles the folder into one ES module that runs on the runner image's `node`, and `catalyst
// tool run <folder>` runs it locally. The platform hands `execute` the input it checked against
// the derived JSON Schema; the Zod schema parses it once more, so defaults and transforms apply.
//
//   import { defineTool } from "@work-shape/catalyst-tool-sdk/code";
//   import { z } from "zod";
//
//   export default defineTool({
//     name: "find_contact",
//     description: "Finds a contact in the CRM by e-mail.",
//     inputSchema: z.object({ email: z.string().email() }),
//     async execute({ email }, ctx) {
//       const found = await ctx.connection("crm").call("find_contact", { email });
//       ctx.display.data("crm.contacts", { contacts: found }, "Contacts");
//       return found;
//     }
//   });

/** What people read, in one language for both, or in English and German. */
export type CodeToolText = string | { en?: string; de?: string };

/** A Connection the tool declares operations of in its `tool.yaml`. */
export interface CodeToolConnection {
  /**
   * Calls `connection.<name>.<operation>` through the platform, as the tool's caller, and
   * answers its output. An operation the tool does not declare, a refusal or a failure rejects
   * with an error whose `code` names why, such as `connection_not_declared`.
   */
  call(operation: string, input?: JsonObject): Promise<JsonValue>;
}

/** What a call shows beside the chat: at most one display, the last one asked for. */
export interface CodeToolDisplay {
  /**
   * Shows data of a display kind: the release's widget of that kind draws it where one is
   * registered, and the platform's data view otherwise.
   */
  data(kind: string, data: JsonObject, title: string): void;
  /** Shows the tool's own HTML in a sandboxed frame without network. */
  html(html: string, title?: string): void;
}

/** What a code tool's handler is handed beside its input, in the sandbox. */
export interface CodeToolContext {
  /** A Connection the tool declares operations of, by its name. */
  connection(name: string): CodeToolConnection;
  display: CodeToolDisplay;
  /** Writes a line to the handler's log, never to the model. */
  log(...values: unknown[]): void;
}

/** A code tool, as its folder's `index.ts` exports it. */
export interface CodeToolDefinition<TInput = unknown> {
  /** Lowercase letters, digits and `_`, starting with a letter; wins over `tool.yaml`. */
  name: string;
  /** What people read on the agent page; wins over `tool.yaml`. */
  title?: CodeToolText;
  /** What the model reads: when to call the tool and what it hands over. */
  description: string;
  /**
   * `changing` when the handler writes state that outlives the call, `reading` otherwise. The
   * platform runs every call of a tool asset as `changing`, under the strictest policy of the
   * Connection operations it declares; the field says what the handler does.
   */
  effect?: OperationEffect;
  inputSchema: z.ZodType<TInput>;
  /** The JSON Schema the model is shown. Derived from `inputSchema` where left out. */
  inputJsonSchema?: JsonObject;
  /** Answers what the model reads, as JSON. */
  execute(input: TInput, ctx: CodeToolContext): unknown;
}

export type DefinedCodeTool<TInput = unknown> = CodeToolDefinition<TInput> & {
  inputJsonSchema: JsonObject;
};

/** Defines a code tool. Its JSON Schema is derived from `inputSchema`, as a release tool's is. */
export function defineTool<TInput>(
  definition: CodeToolDefinition<TInput>
): DefinedCodeTool<TInput> {
  return {
    ...definition,
    inputJsonSchema: definition.inputJsonSchema ?? deriveInputJsonSchema(definition.inputSchema)
  };
}
