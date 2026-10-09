import {
  apiOperations,
  runObservationSchema,
  type RunObservation
} from "@vivd-catalyst/api-contract";
import * as generatedSdk from "./generated/sdk.gen";
import {
  apiErrorFromGeneratedResult,
  type ApiClientTransport,
  type OperationRequestInput
} from "./transport";

export interface ObserveRunEventsOptions {
  afterSequence?: number;
  signal?: AbortSignal;
  onCaughtUp?: () => void;
}

export function createRunsClient(transport: ApiClientTransport) {
  return {
    start: (
      conversationId: string,
      input: OperationRequestInput<typeof apiOperations.startConversationRun>
    ) =>
      transport.unwrapJson(
        generatedSdk.startConversationRun({
          client: transport.generatedClient,
          path: { conversationId },
          body: apiOperations.startConversationRun.body.parse(input)
        }),
        apiOperations.startConversationRun.response.schema
      ),
    create: (input: OperationRequestInput<typeof apiOperations.createConversationRun>) =>
      transport.unwrapJson(
        generatedSdk.createConversationRun({
          client: transport.generatedClient,
          body: apiOperations.createConversationRun.body.parse(input)
        }),
        apiOperations.createConversationRun.response.schema
      ),
    cancel: (
      conversationId: string,
      runId: string,
      input: OperationRequestInput<typeof apiOperations.cancelConversationRun> = {}
    ) =>
      transport.unwrapJson(
        generatedSdk.cancelConversationRun({
          client: transport.generatedClient,
          path: { conversationId, runId },
          body: apiOperations.cancelConversationRun.body.parse(input)
        }),
        apiOperations.cancelConversationRun.response.schema
      ),
    command: (
      conversationId: string,
      runId: string,
      input: OperationRequestInput<typeof apiOperations.commandConversationRun>
    ) =>
      transport.unwrapJson(
        generatedSdk.commandConversationRun({
          client: transport.generatedClient,
          path: { conversationId, runId },
          body: apiOperations.commandConversationRun.body.parse(input)
        }),
        apiOperations.commandConversationRun.response.schema
      ),
    observe: (conversationId: string, runId: string, options: ObserveRunEventsOptions = {}) =>
      observeRunEvents(transport, conversationId, runId, options)
  };
}

async function* observeRunEvents(
  transport: ApiClientTransport,
  conversationId: string,
  runId: string,
  options: ObserveRunEventsOptions
): AsyncIterable<RunObservation> {
  const result = await transport.generatedClient.get<ReadableStream<Uint8Array>, unknown>({
    url: "/api/conversations/{conversationId}/runs/{runId}/events",
    path: { conversationId, runId },
    query:
      options.afterSequence === undefined ? undefined : { after: String(options.afterSequence) },
    headers: {
      accept: "text/event-stream"
    },
    parseAs: "stream",
    signal: options.signal
  });
  const response = result.response;
  if (!response) {
    if (result.error instanceof Error && result.error.name === "AbortError") {
      throw result.error;
    }
    throw apiErrorFromGeneratedResult(result);
  }
  if (response.status === 204) {
    options.onCaughtUp?.();
    return;
  }
  if (result.error !== undefined) {
    throw apiErrorFromGeneratedResult(result);
  }
  if (!result.data) {
    return;
  }

  const reader = result.data.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const events = splitCompleteSseEvents(buffer);
      buffer = events.remaining;
      for (const event of events.blocks) {
        const observation = parseRunObservationSseBlock(event);
        if (observation) {
          yield observation;
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const observation = parseRunObservationSseBlock(buffer);
      if (observation) {
        yield observation;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function splitCompleteSseEvents(buffer: string): { blocks: string[]; remaining: string } {
  const normalized = buffer.replaceAll("\r\n", "\n");
  const parts = normalized.split("\n\n");
  const remaining = parts.pop() ?? "";
  return {
    blocks: parts.filter((part) => part.trim().length > 0),
    remaining
  };
}

function parseRunObservationSseBlock(block: string): RunObservation | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) {
    return undefined;
  }
  return runObservationSchema.parse(JSON.parse(data));
}
