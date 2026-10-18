import { spawn } from "node:child_process";
import { defineProvider, createPlatformId } from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  type ModelAdapterFactory,
  type ModelCompletion,
  type ModelAdapterRequest
} from "@work-shape/catalyst-model-provider";
import type { ClientInstanceCapability } from "@work-shape/catalyst-client-assembly";
import { z } from "zod";

/** One live model turn must finish within two minutes; the test cancels a hung CLI. */
const LIVE_MODEL_TIMEOUT_MS = 120_000;
/** Bounds the structured reply before parsing it. */
const LIVE_MODEL_OUTPUT_MAX_BYTES = 2_097_152;
export const RECORDS_LIVE_MODEL_PROVIDER = "records-live-cli";
const completionSchema = z.object({
  text: z.string(),
  toolCalls: z.array(z.object({ toolName: z.string(), input: z.unknown() }))
});
const cliResultSchema = z.object({
  is_error: z.boolean().optional(),
  structured_output: completionSchema,
  modelUsage: z.record(z.string(), z.unknown())
});

/**
 * Opt-in acceptance transport using the already authenticated Opus CLI. No model is scripted:
 * the platform's complete messages and offered tool schemas are sent unchanged. The CLI has
 * no native tools or MCP servers; it answers the same text/tool-call protocol as an adapter.
 * This is a test transport, not a product provider or a live customer instance.
 */
export function recordsLiveCliModel(): {
  capability: ClientInstanceCapability;
  models: Set<string>;
} {
  const models = new Set<string>();
  async function complete(request: ModelAdapterRequest): Promise<ModelCompletion> {
    const schema = z.toJSONSchema(completionSchema, { target: "draft-07" });
    const protocol =
      "Implement one model completion for the supplied request. Follow its system messages. Its tools are the available functions. Return text for the person and toolCalls with toolName and input for any function calls you choose. The host executes your requested toolCalls and supplies their results in the next request. The CLI itself executes no tools.";
    const raw = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        "claude",
        [
          "-p",
          "--model",
          "opus",
          "--max-turns",
          "2",
          "--tools",
          "",
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--setting-sources",
          "",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(schema),
          "--system-prompt",
          protocol
        ],
        {
          cwd: "/tmp",
          stdio: ["pipe", "pipe", "ignore"],
          ...(request.signal ? { signal: request.signal } : {})
        }
      );
      let output = "";
      const timer = setTimeout(() => {
        child.kill("SIGINT");
        reject(new Error("The live model turn exceeded its deadline"));
      }, LIVE_MODEL_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        reject(new Error("The live model CLI could not start"));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > LIVE_MODEL_OUTPUT_MAX_BYTES) {
          child.kill("SIGINT");
          clearTimeout(timer);
          reject(new Error("The live model reply exceeded its byte limit"));
        }
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(output);
        else reject(new Error("The live model CLI did not complete successfully"));
      });
      child.stdin.end(JSON.stringify(request));
    });
    const result = cliResultSchema.parse(JSON.parse(raw));
    if (result.is_error) throw new Error("The live model returned an error");
    for (const name of Object.keys(result.modelUsage)) models.add(name);
    return {
      ...result.structured_output,
      toolCalls: result.structured_output.toolCalls.map((call) => ({
        ...call,
        toolCallId: createPlatformId("tc")
      })),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        source: "not_reported",
        webSearchCallCount: 0
      }
    };
  }
  const provider = defineProvider({
    port: "models",
    type: RECORDS_LIVE_MODEL_PROVIDER,
    configSchema: z.object({}),
    external: false,
    create(): ModelAdapterFactory {
      return () => ({
        capabilities: () => DETERMINISTIC_CAPABILITIES,
        complete,
        async *stream(request) {
          yield { type: "completed", completion: await complete(request) };
        }
      });
    },
    check: async () => ({ ok: true }),
    describe: () => ({})
  });
  return {
    capability: { name: "records-live-cli", providers: [provider], create: () => ({}) },
    models
  };
}
